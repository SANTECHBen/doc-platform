// Orchestrator — dispatch a document buffer to the right extractor.
// Callers pass the raw buffer and either a document kind or a content-type;
// we resolve to the concrete extractor and return a normalized ExtractionResult.
//
// The kind/content-type combo is deliberately belt-and-suspenders — the admin
// UI records both, and they sometimes disagree (e.g., a .pptx uploaded as
// `kind: file`). Content-type wins when ambiguous.

import { extractPdf } from './pdf.js';
import { extractDocx } from './docx.js';
import { extractPptx } from './pptx.js';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';

export type { ExtractionResult, ExtractedPage } from './types.js';
export { ExtractionError } from './types.js';

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
  buffer: Buffer;
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
      return extractPdf(input.buffer);
    case 'docx':
      return extractDocx(input.buffer);
    case 'pptx':
      return extractPptx(input.buffer);
    default:
      throw new ExtractionError(
        `No extractor for format "${format}" (kind=${input.kind}, contentType=${input.contentType})`,
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
