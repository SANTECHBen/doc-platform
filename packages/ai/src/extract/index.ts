// Orchestrator — dispatch a source file on disk to the right extractor.
// Callers stream the upload to a temp file and pass the path, plus a kind
// and/or content-type hint; we resolve to the concrete extractor and return
// a normalized ExtractionResult.
//
// The file-path interface (instead of an in-memory Buffer) is what lets the
// PDF extractor split huge documents on disk via qpdf without holding the
// whole PDF structure in JS memory at once. DOCX / PPTX extractors are
// buffered internally — those formats are small enough in practice and the
// libraries we use only take Buffers.
//
// The kind/content-type combo is deliberately belt-and-suspenders — the admin
// UI records both, and they sometimes disagree (e.g., a .pptx uploaded as
// `kind: file`). Content-type wins when ambiguous.

import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractPptx } from './pptx.js';
import {
  extractDocxWithFigures,
  extractDocxText,
  extractDocxFigureBytes,
} from './docx-figures.js';
import {
  extractPdfWithFigures,
  extractPdfText,
  extractPdfFiguresForSlice,
} from './pdf-figures.js';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';
import { attachCaptions, type ExtractedFigure, type FigureAwareExtraction } from './figures.js';

export type { ExtractionResult, ExtractedPage } from './types.js';
export { ExtractionError } from './types.js';
export type { FigureAwareExtraction, ExtractedFigure } from './figures.js';

// MIME types we recognize. Anything else → ExtractionError (caller marks the
// doc as failed with a clear message for the admin UI).
const PDF_MIME = new Set(['application/pdf']);
const DOCX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const PPTX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export interface ExtractInput {
  /** Absolute path to the source file on local disk. The orchestrator
   *  upstream streams from object storage into a temp file and passes the
   *  path here for buffered extractors (DOCX, PPTX). */
  filePath: string;
  /** Publicly reachable URL for the same file (typically the R2 public
   *  endpoint). When provided, extractors that support remote fetch
   *  (PDF → LlamaParse) skip the local file entirely and tell the upstream
   *  service to pull bytes directly. Critical for large PDFs — the API
   *  process never has to hold 100+ MB of file bytes in memory. */
  sourceUrl?: string | null;
  /** Document kind from the enum (kind column). Used as a hint. */
  kind?: string | null;
  /** MIME type from upload. Authoritative when present. */
  contentType?: string | null;
  /** Original filename. Used as a last-resort hint via extension. */
  filename?: string | null;
}

export async function extract(input: ExtractInput): Promise<ExtractionResult> {
  const format = resolveFormat(input);
  switch (format) {
    case 'pdf':
      return extractPdf({ filePath: input.filePath, sourceUrl: input.sourceUrl });
    case 'docx':
      return extractDocx(input.filePath);
    case 'pptx':
      return extractPptx(input.filePath);
    default:
      throw new ExtractionError(
        `No extractor for format "${format}" (kind=${input.kind}, contentType=${input.contentType})`,
      );
  }
}

/**
 * Figure-aware extraction for the procedure importer. Unlike extract(), which
 * drops images for RAG, this keeps each embedded figure as bytes and leaves a
 * `[[FIGURE:fig-N]]` token where it sat. Only docx + pdf are supported (the
 * importer's two source kinds); pptx falls through to an error.
 */
export async function extractWithFigures(
  input: ExtractInput,
): Promise<FigureAwareExtraction> {
  const format = resolveFormat(input);
  switch (format) {
    case 'docx':
      return extractDocxWithFigures(input.filePath);
    case 'pdf':
      return extractPdfWithFigures({
        filePath: input.filePath,
        sourceUrl: input.sourceUrl,
      });
    default:
      throw new ExtractionError(
        `No figure-aware extractor for format "${format}" (kind=${input.kind}, contentType=${input.contentType})`,
      );
  }
}

/**
 * Phase 1 of section-scoped import: extract just the markdown (with figure
 * tokens for docx; page markers for pdf) so the admin can pick sections.
 * Decodes NO figure image bytes — that's deferred to extractFiguresForSections
 * so figures are only pulled from the sections actually selected.
 */
export async function extractDocumentText(
  input: ExtractInput,
): Promise<{ markdown: string; meta: ExtractionResult['meta'] }> {
  const format = resolveFormat(input);
  switch (format) {
    case 'docx':
      return extractDocxText(input.filePath);
    case 'pdf':
      return extractPdfText({ filePath: input.filePath, sourceUrl: input.sourceUrl });
    default:
      throw new ExtractionError(
        `No text extractor for format "${format}" (kind=${input.kind}, contentType=${input.contentType})`,
      );
  }
}

/**
 * Phase 2 of section-scoped import: decode + return figure image bytes ONLY
 * for the figures inside `slicedMarkdown` (the selected sections). Returns the
 * slice with figure tokens guaranteed present (pdf injects them here). The
 * caller uploads the bytes and feeds the returned markdown to the LLM.
 */
export async function extractFiguresForSections(
  input: ExtractInput,
  slicedMarkdown: string,
): Promise<{ figures: ExtractedFigure[]; markdown: string }> {
  const format = resolveFormat(input);
  switch (format) {
    case 'docx': {
      const wanted = new Set(
        [...slicedMarkdown.matchAll(/\[\[FIGURE:(fig-\d+)\]\]/g)].map((m) => m[1]!),
      );
      const figures = await extractDocxFigureBytes(input.filePath, wanted);
      attachCaptions(slicedMarkdown, figures);
      return { figures, markdown: slicedMarkdown };
    }
    case 'pdf':
      return extractPdfFiguresForSlice(input.filePath, slicedMarkdown);
    default:
      throw new ExtractionError(
        `No figure extractor for format "${format}" (kind=${input.kind}, contentType=${input.contentType})`,
      );
  }
}

function resolveFormat(input: ExtractInput): 'pdf' | 'docx' | 'pptx' | 'unknown' {
  const ct = input.contentType?.toLowerCase();
  if (ct) {
    if (PDF_MIME.has(ct)) return 'pdf';
    if (DOCX_MIME.has(ct)) return 'docx';
    if (PPTX_MIME.has(ct)) return 'pptx';
  }
  // Fall back to the document kind when the MIME was missing or generic
  // (e.g., application/octet-stream from a stingy browser).
  if (input.kind === 'pdf') return 'pdf';
  if (input.kind === 'slides') return 'pptx';
  // Then to filename extension — last resort.
  const ext = input.filename?.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  return 'unknown';
}

/**
 * Does this document look extractable? Used at upload time to decide whether
 * to set extractionStatus=pending or not_applicable. Keep permissive — the
 * extractor itself will flag unsupported content.
 */
export function isExtractable(kind: string | null, contentType: string | null): boolean {
  const ct = contentType?.toLowerCase();
  if (ct && (PDF_MIME.has(ct) || DOCX_MIME.has(ct) || PPTX_MIME.has(ct))) return true;
  return kind === 'pdf' || kind === 'slides';
}
