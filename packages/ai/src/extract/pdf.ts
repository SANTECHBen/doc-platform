// PDF extraction via Claude's native document ingestion.
//
// Rather than run a JS text-layer extractor (unpdf / pdfjs-dist) and fall back
// to an LLM for scanned/complex pages, we just send every PDF to Claude. This
// is:
//   - Simpler — one code path, no library incompatibilities.
//   - Higher quality — Claude handles scans, tables, multi-column layouts,
//     and figures (which it describes in prose, useful for RAG).
//   - Comparable in cost — haiku at ~$0.25/1M input tokens × a 10-page PDF ≈
//     $0.001. Well under the budget for the quality lift.
//
// Anthropic's API caps PDFs at 100 pages per request. Larger docs are split
// page-wise here, extracted in parallel-ish chunks, and the resulting
// markdown concatenated. We rewrite each chunk's `<!-- page:N -->` markers
// from local (1-indexed within chunk) to global (1-indexed within original
// doc) so downstream consumers (sections, citations, chunker) all see one
// continuous numbering.
//
// If ANTHROPIC_API_KEY is missing the function throws, because without it we
// have no way to extract anything at all.

import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';

// Haiku is more than capable for transcription. Reserving Sonnet/Opus here
// would be overkill and burn budget.
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

// Anthropic's PDF page limit per request. We split larger PDFs into
// page-bounded sub-PDFs and extract each independently.
const PDF_PAGES_PER_REQUEST = 100;

// Max bytes per request — Anthropic's hard cap is 32MB. Same value enforced
// after splitting; if a single 100-page chunk still exceeds 32MB (image-heavy
// scans), we surface the error rather than silently dropping pages.
const PDF_MAX_BYTES_PER_REQUEST = 32 * 1024 * 1024;

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ExtractionError('ANTHROPIC_API_KEY is not set — cannot extract PDFs');
  }

  // Probe page count first. If <= 100, send as-is (fast path, identical to
  // the prior single-request flow). If >100, split into page-bounded chunks.
  let totalPages: number;
  try {
    const probe = await PDFDocument.load(buffer, { updateMetadata: false });
    totalPages = probe.getPageCount();
  } catch (err) {
    throw new ExtractionError(
      `Could not parse PDF for page count: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const client = new Anthropic();

  if (totalPages <= PDF_PAGES_PER_REQUEST) {
    if (buffer.length > PDF_MAX_BYTES_PER_REQUEST) {
      throw new ExtractionError(
        `PDF is ${Math.round(buffer.length / 1024 / 1024)}MB — over Anthropic's 32MB limit`,
      );
    }
    const markdown = await extractChunk(client, buffer, 1);
    return finalize(markdown, totalPages, ['extracted via Claude (single chunk)']);
  }

  // Multi-chunk path. Split into ≤100-page sub-PDFs, extract each, and
  // concatenate. Sequential (not parallel) so we don't blow the API rate
  // limit on a single document — pipelining many docs is the parent's job.
  const chunks = await splitPdfIntoPageChunks(buffer, PDF_PAGES_PER_REQUEST);
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.bytes.length > PDF_MAX_BYTES_PER_REQUEST) {
      throw new ExtractionError(
        `PDF chunk pages ${chunk.startPage}-${chunk.endPage} is ${Math.round(
          chunk.bytes.length / 1024 / 1024,
        )}MB — over Anthropic's 32MB limit. Try splitting this doc upstream.`,
      );
    }
    const md = await extractChunk(client, chunk.bytes, chunk.startPage);
    parts.push(md);
  }

  const markdown = parts.join('\n\n').trim();
  if (markdown.length === 0) {
    throw new ExtractionError('Claude returned empty markdown across all PDF chunks');
  }

  return finalize(markdown, totalPages, [
    `extracted via Claude (${chunks.length} chunks of ≤${PDF_PAGES_PER_REQUEST} pages each)`,
  ]);
}

interface PageChunk {
  startPage: number; // 1-indexed within the original doc
  endPage: number; // 1-indexed inclusive
  bytes: Buffer;
}

async function splitPdfIntoPageChunks(
  buffer: Buffer,
  pagesPerChunk: number,
): Promise<PageChunk[]> {
  const src = await PDFDocument.load(buffer, { updateMetadata: false });
  const total = src.getPageCount();
  const chunks: PageChunk[] = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, total);
    const dst = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await dst.copyPages(src, pageIndices);
    for (const p of copied) dst.addPage(p);
    const out = await dst.save({ useObjectStreams: false });
    chunks.push({
      startPage: start + 1,
      endPage: end,
      bytes: Buffer.from(out),
    });
  }
  return chunks;
}

/**
 * Extract one ≤100-page chunk. `startPage` is the original-document page
 * number that this chunk's first page corresponds to — used to rewrite the
 * `<!-- page:N -->` markers Claude emits (which are local to the chunk).
 */
async function extractChunk(
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
            {
              type: 'text',
              text: [
                'Extract the full text of this PDF as clean GitHub-flavored Markdown.',
                'Preserve document structure — headings become #, ##, ###; lists become - or 1.; tables become GFM tables.',
                'For figures and diagrams, write a one-sentence description in *italics* so retrieval can match questions about them.',
                'Insert `<!-- page:N -->` at the start of each page so citations can reference specific pages.',
                'Output the markdown only — no preamble, explanation, or commentary.',
              ].join(' '),
            },
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
