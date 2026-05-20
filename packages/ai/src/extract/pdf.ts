// PDF extraction via Claude's native document ingestion.
//
// Rather than run a JS text-layer extractor (unpdf / pdfjs-dist) and fall back
// to an LLM for scanned/complex pages, we send every PDF to Claude. This is:
//   - Simpler — one code path, no library incompatibilities.
//   - Higher quality — Claude handles scans, tables, multi-column layouts,
//     and figures (which it describes in prose, useful for RAG).
//   - Comparable in cost — haiku at ~$0.25/1M input tokens × a 10-page PDF ≈
//     $0.001. Well under the budget for the quality lift.
//
// Anthropic's API caps PDFs at 100 pages AND 32 MB per request, so larger
// docs get split. The split is done via the `qpdf` system binary against the
// PDF on disk, NOT via pdf-lib in memory — the latter materializes the whole
// PDF object graph into JS objects (3-5x the file size) which OOMs a small
// box on 100MB+ inputs. With qpdf, only one ≤32 MB chunk is held in memory at
// a time, regardless of source size.
//
// Chunk windowing is adaptive: start with 100 pages, halve on Anthropic's
// 32 MB request cap (image-heavy chapters). Bottom out at a 1-page request;
// if a single page alone exceeds 32 MB the doc has a pathological embedded
// image and the user gets a clear error pointing at that page.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';

// Haiku is more than capable for transcription. Reserving Sonnet/Opus here
// would be overkill and burn budget.
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

// Anthropic's per-request page cap. Initial window size before adaptive
// halving kicks in.
const PDF_PAGES_PER_REQUEST = 100;

// Anthropic's per-request byte cap. We measure the on-disk size of each
// chunk file BEFORE reading it into memory; over this, we halve the window
// and try again.
const PDF_MAX_BYTES_PER_REQUEST = 32 * 1024 * 1024;

export async function extractPdf(filePath: string): Promise<ExtractionResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ExtractionError('ANTHROPIC_API_KEY is not set — cannot extract PDFs');
  }

  // Probe page count via qpdf. Reads the PDF's xref table only; doesn't
  // load the page tree into memory. O(1) RAM regardless of file size.
  let totalPages: number;
  try {
    totalPages = await qpdfPageCount(filePath);
  } catch (err) {
    throw new ExtractionError(
      `Could not read PDF page count via qpdf: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (totalPages <= 0) {
    throw new ExtractionError('PDF reports 0 pages');
  }

  const client = new Anthropic();

  // Per-doc temp dir so concurrent extractions don't collide. mkdtemp adds
  // a random suffix; finally{} below removes the whole dir whether we
  // succeeded or threw.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-extract-'));
  try {
    const parts: string[] = [];
    let cursor = 1;
    let chunkCount = 0;
    while (cursor <= totalPages) {
      const result = await extractWindow(client, filePath, workDir, cursor, totalPages);
      parts.push(result.markdown);
      cursor = result.nextPage;
      chunkCount += 1;
    }
    const markdown = parts.join('\n\n').trim();
    if (markdown.length === 0) {
      throw new ExtractionError('Claude returned empty markdown across all PDF chunks');
    }
    return finalize(markdown, totalPages, [
      `extracted via Claude (${chunkCount} chunk${chunkCount === 1 ? '' : 's'}, streamed)`,
    ]);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pull one window of pages out of the source PDF, send to Claude, and
 * return the resulting markdown plus the cursor for the next window. The
 * window size is adaptive — we try 100 pages first and halve until the
 * resulting chunk file fits under Anthropic's 32 MB request cap.
 */
async function extractWindow(
  client: Anthropic,
  sourcePath: string,
  workDir: string,
  startPage: number,
  totalPages: number,
): Promise<{ markdown: string; nextPage: number }> {
  let windowSize = Math.min(PDF_PAGES_PER_REQUEST, totalPages - startPage + 1);
  while (windowSize >= 1) {
    const endPage = startPage + windowSize - 1;
    const chunkPath = path.join(workDir, `chunk_${startPage}-${endPage}.pdf`);
    try {
      await qpdfExtractRange(sourcePath, startPage, endPage, chunkPath);
      const stat = await fs.stat(chunkPath);
      if (stat.size > PDF_MAX_BYTES_PER_REQUEST) {
        if (windowSize === 1) {
          const mb = Math.round(stat.size / 1024 / 1024);
          throw new ExtractionError(
            `Page ${startPage} alone is ${mb} MB — over Anthropic's 32 MB request cap. This page likely embeds a very large image. Compress or remove that page before retrying.`,
          );
        }
        windowSize = Math.floor(windowSize / 2);
        continue;
      }
      const buffer = await fs.readFile(chunkPath);
      const md = await extractChunkViaAnthropic(client, buffer, startPage);
      return { markdown: md, nextPage: endPage + 1 };
    } finally {
      await fs.unlink(chunkPath).catch(() => {});
    }
  }
  // Should be unreachable — the loop above either returns or throws.
  throw new ExtractionError('adaptive window collapsed to 0 pages — internal bug');
}

async function qpdfPageCount(filePath: string): Promise<number> {
  const { stdout } = await runCommand('qpdf', ['--show-npages', filePath]);
  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`qpdf returned unexpected page count: "${stdout.trim()}"`);
  }
  return n;
}

async function qpdfExtractRange(
  source: string,
  startPage: number,
  endPage: number,
  outPath: string,
): Promise<void> {
  // qpdf source.pdf --pages . start-end -- out.pdf
  // The lone period means "the same input file"; the range is inclusive
  // and 1-indexed. qpdf streams pages without unpacking the whole doc.
  await runCommand('qpdf', [
    source,
    '--pages',
    '.',
    `${startPage}-${endPage}`,
    '--',
    outPath,
  ]);
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child process and collect stdout/stderr. qpdf is well-behaved:
 * exit 0 = success, exit 3 = warnings (e.g., "linearization not
 * preserved" on lightly-malformed PDFs), exit ≥2 = real error. We accept
 * exits 0 and 3, reject others.
 */
function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (d) => stdout.push(d));
    child.stderr?.on('data', (d) => stderr.push(d));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      const result: CommandResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0 || code === 3) {
        resolve(result);
      } else {
        const tag = `${cmd} ${args.slice(-2).join(' ')}`;
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${code}`;
        reject(new Error(`${tag} failed (exit ${code}): ${detail}`));
      }
    });
  });
}

async function extractChunkViaAnthropic(
  client: Anthropic,
  buffer: Buffer,
  startPage: number,
): Promise<string> {
  const base64 = buffer.toString('base64');
  let message;
  try {
    // SDK 0.32 doesn't type the `document` content block yet. The API accepts
    // it at runtime; cast to bypass the stale type until the SDK is upgraded.
    message = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 16_000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
              },
            } as any,
            { type: 'text', text: PROMPT_TEXT },
          ],
        },
      ],
    });
  } catch (err) {
    throw new ExtractionError(
      `Claude PDF extraction failed (chunk starting at page ${startPage}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new ExtractionError(
      `Claude returned no text content for PDF chunk starting at page ${startPage}`,
    );
  }

  const md = textBlock.text.trim();
  // Rewrite local page markers to global. Claude emits `<!-- page:1 -->`,
  // `<!-- page:2 -->`, etc. relative to the chunk it saw. For the second
  // chunk (startPage=101), local 1 → global 101, local 2 → global 102, etc.
  if (startPage > 1) {
    return md.replace(/<!--\s*page:(\d+)\s*-->/g, (_, n) => {
      const local = Number(n);
      return `<!-- page:${local + startPage - 1} -->`;
    });
  }
  return md;
}

const PROMPT_TEXT = [
  'Extract the full text of this PDF as clean GitHub-flavored Markdown.',
  'Preserve document structure — headings become #, ##, ###; lists become - or 1.; tables become GFM tables.',
  'For figures and diagrams, write a one-sentence description in *italics* so retrieval can match questions about them.',
  'Insert `<!-- page:N -->` at the start of each page so citations can reference specific pages.',
  'Output the markdown only — no preamble, explanation, or commentary.',
].join(' ');

function finalize(
  markdown: string,
  totalPages: number,
  extraNotes: string[],
): ExtractionResult {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    throw new ExtractionError('Claude returned empty markdown for PDF');
  }
  const pages = parsePageMarkers(trimmed);
  return {
    markdown: trimmed,
    pages,
    meta: {
      source: 'pdf',
      quality: 0.9,
      notes: [`pages: ${totalPages}`, ...extraNotes],
    },
  };
}

function parsePageMarkers(markdown: string): Array<{
  pageNumber: number;
  charStart: number;
  charEnd: number;
}> {
  const pages: Array<{ pageNumber: number; charStart: number; charEnd: number }> = [];
  const re = /<!--\s*page:(\d+)\s*-->/g;
  const matches: Array<{ pageNumber: number; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    matches.push({ pageNumber: Number(m[1]), start: m.index });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.start;
    const end = i + 1 < matches.length ? matches[i + 1]!.start : markdown.length;
    pages.push({ pageNumber: matches[i]!.pageNumber, charStart: start, charEnd: end });
  }
  return pages;
}
