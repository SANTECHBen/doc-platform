// PDF extraction via LlamaParse (https://cloud.llamaindex.ai).
//
// We previously ran extraction in-process — first via pdf-lib, then via a
// streaming qpdf+Claude pipeline. Both implementations fought the same
// underlying problem: doing minutes of CPU+memory-heavy work inside the API
// process that also serves the admin UI. Every fix (more RAM, more CPU,
// streaming, niceness, performance CPU) was a workaround for an
// architectural mismatch.
//
// LlamaParse is purpose-built for "PDF → clean markdown for RAG." It's a
// hosted async job service: we POST the file, poll for completion, then
// fetch back per-page markdown. Our process never holds the PDF longer
// than the upload itself, never runs a PDF parser, never base64-encodes
// 32 MB chunks. The API stays responsive throughout because all the heavy
// work is on someone else's machine.
//
// Cost: roughly $0.003 per page on the paid tier; free tier covers 1,000
// pages/day. A 600-page manual is ~$1.80 to extract.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';

export interface PdfExtractInput {
  /** Local path to the PDF. Used as a fallback when sourceUrl isn't set
   *  (dev environments without S3_PUBLIC_URL). When sourceUrl IS set we
   *  ignore this entirely — LlamaParse pulls from R2 directly. */
  filePath: string;
  /** Publicly reachable URL for the PDF (R2 public endpoint). Strongly
   *  preferred: when set, our process never reads the file into memory.
   *  A 120 MB PDF that would OOM the 1 GB Fly box via multipart upload
   *  travels straight from R2 → LlamaParse, with our process holding
   *  zero bytes. */
  sourceUrl?: string | null;
}

const LLAMA_BASE_URL = 'https://api.cloud.llamaindex.ai/api/v1';

// Hard timeout for one PDF job. LlamaParse usually returns in 30-180s, but
// huge image-heavy manuals can run longer. Above this we treat the job as
// failed and surface a clear message — the user can retry or split the PDF.
const JOB_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// How often we poll the job status endpoint.
const POLL_INTERVAL_MS = 5_000;

export async function extractPdf(input: PdfExtractInput): Promise<ExtractionResult> {
  const apiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    throw new ExtractionError(
      'LLAMA_CLOUD_API_KEY is not set — PDF extraction is delegated to LlamaParse. ' +
        'Sign up at https://cloud.llamaindex.ai, generate an API key, and set it as ' +
        'a Fly secret: `fly secrets set LLAMA_CLOUD_API_KEY=llx-... --app equipment-hub-api`.',
    );
  }

  const jobId = input.sourceUrl
    ? await uploadJobByUrl(input.sourceUrl, apiKey)
    : await uploadJobByFile(input.filePath, apiKey);
  await waitForJob(jobId, apiKey);
  const { pages, totalPages } = await fetchResult(jobId, apiKey);

  // Reassemble into a single markdown string with `<!-- page:N -->` markers
  // between pages — same shape our chunker, citations, and sections already
  // expect, so nothing downstream changes.
  const parts: string[] = [];
  for (const p of pages) {
    parts.push(`<!-- page:${p.page} -->`);
    parts.push(p.md.trim());
  }
  const markdown = parts.join('\n\n').trim();
  if (markdown.length === 0) {
    throw new ExtractionError('LlamaParse returned an empty result');
  }

  return {
    markdown,
    pages: parsePageMarkers(markdown),
    meta: {
      source: 'pdf',
      quality: 0.92,
      notes: [
        `pages: ${totalPages}`,
        'extracted via LlamaParse',
      ],
    },
  };
}

interface ParsedPage {
  page: number;
  md: string;
}

/** Preferred path: hand LlamaParse a URL and let it pull bytes from R2
 *  directly. Our process never holds the PDF — zero memory cost. */
async function uploadJobByUrl(sourceUrl: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('input_url', sourceUrl);

  let resp: Response;
  try {
    resp = await fetch(`${LLAMA_BASE_URL}/parsing/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new ExtractionError(
      `LlamaParse URL-upload failed (network): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!resp.ok) {
    const detail = await safeBody(resp);
    throw new ExtractionError(
      `LlamaParse URL-upload rejected (HTTP ${resp.status}): ${detail}. ` +
        `Verify the URL ${sourceUrl} is publicly reachable.`,
    );
  }
  const body = (await resp.json()) as { id?: string };
  if (!body.id) {
    throw new ExtractionError(`LlamaParse URL-upload returned no job id: ${JSON.stringify(body)}`);
  }
  return body.id;
}

/** Fallback path used in dev environments where there's no public URL for
 *  the storage (e.g., local fs adapter, or S3 bucket configured private).
 *  Reads the whole file into memory — fine for small dev files, OOM-prone
 *  for production-scale PDFs. */
async function uploadJobByFile(filePath: string, apiKey: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: 'application/pdf' }),
    path.basename(filePath) || 'document.pdf',
  );

  let resp: Response;
  try {
    resp = await fetch(`${LLAMA_BASE_URL}/parsing/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new ExtractionError(
      `LlamaParse upload failed (network): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!resp.ok) {
    const detail = await safeBody(resp);
    throw new ExtractionError(
      `LlamaParse upload rejected (HTTP ${resp.status}): ${detail}. ` +
        `File size: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB.`,
    );
  }
  const body = (await resp.json()) as { id?: string };
  if (!body.id) {
    throw new ExtractionError(`LlamaParse upload returned no job id: ${JSON.stringify(body)}`);
  }
  return body.id;
}

async function waitForJob(jobId: string, apiKey: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < JOB_TIMEOUT_MS) {
    let resp: Response;
    try {
      resp = await fetch(`${LLAMA_BASE_URL}/parsing/job/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      throw new ExtractionError(
        `LlamaParse status poll failed (network): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    if (!resp.ok) {
      const detail = await safeBody(resp);
      throw new ExtractionError(
        `LlamaParse status check rejected (HTTP ${resp.status}): ${detail}`,
      );
    }
    const body = (await resp.json()) as { status?: string; error_message?: string };
    if (body.status === 'SUCCESS') return;
    if (body.status === 'ERROR' || body.status === 'CANCELLED') {
      throw new ExtractionError(
        `LlamaParse job ${jobId} ${body.status}: ${body.error_message ?? 'no detail'}`,
      );
    }
    // PENDING or anything else — wait and re-poll.
    await sleep(POLL_INTERVAL_MS);
  }
  throw new ExtractionError(
    `LlamaParse job ${jobId} did not finish within ${JOB_TIMEOUT_MS / 1000}s — the document is unusually large or the service is degraded.`,
  );
}

async function fetchResult(
  jobId: string,
  apiKey: string,
): Promise<{ pages: ParsedPage[]; totalPages: number }> {
  let resp: Response;
  try {
    resp = await fetch(`${LLAMA_BASE_URL}/parsing/job/${jobId}/result/json`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    throw new ExtractionError(
      `LlamaParse result fetch failed (network): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (!resp.ok) {
    const detail = await safeBody(resp);
    throw new ExtractionError(
      `LlamaParse result fetch rejected (HTTP ${resp.status}): ${detail}`,
    );
  }
  const body = (await resp.json()) as {
    pages?: Array<{ page?: number; md?: string; text?: string }>;
  };
  const rawPages = body.pages ?? [];
  if (rawPages.length === 0) {
    throw new ExtractionError('LlamaParse returned 0 pages — the PDF may be empty or unsupported');
  }
  const pages: ParsedPage[] = rawPages.map((p, i) => ({
    page: typeof p.page === 'number' ? p.page : i + 1,
    md: (p.md ?? p.text ?? '').trim(),
  }));
  return { pages, totalPages: pages.length };
}

async function safeBody(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '<no body>';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
