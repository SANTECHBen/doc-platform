import { eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import {
  processDocument,
  convertPptxToSlideImages,
  readSpeakerNotesFromPptx,
} from '@platform/ai';
import { revalidateDocumentSections } from './section-revalidation-hook';
import { synthesizeProcedureMarkdown } from './synthesize-procedure-md';
import type { Storage } from '../storage';

// Loose ceiling on doc size — anything past this is rejected up-front
// instead of being handed to the extraction pipeline. LlamaParse has its
// own per-plan limits (currently 50-100 MB); this is mostly to catch
// accidentally-uploaded gigabyte files before they tie up a worker.
const MAX_EXTRACT_BYTES = 250 * 1024 * 1024;

// Open a readable stream against an object-storage key. Used by the
// pipeline to pipe DOCX/PPTX into temp files; PDFs usually go via URL
// hand-off directly to LlamaParse and never touch this stream.
async function openFileStream(
  storage: Storage,
  storageKey: string,
): Promise<NodeJS.ReadableStream> {
  const result = await storage.stream(storageKey);
  if (!result) throw new Error(`File not found in storage: ${storageKey}`);
  return result.stream;
}

/**
 * Mark a document for extraction. The worker process polls for docs in
 * 'pending' status and runs the actual extraction; this function does
 * nothing more than flip the status flag. Splitting "enqueue" from "run"
 * means the API process never blocks on extraction work — the heavy
 * lifting lives entirely in the worker.
 */
export async function enqueueExtraction(
  db: Database,
  documentId: string,
): Promise<void> {
  await db
    .update(schema.documents)
    .set({ extractionStatus: 'pending', extractionError: null })
    .where(eq(schema.documents.id, documentId));
}

export interface ExtractionContext {
  db: Database;
  storage: Storage;
  log?: {
    info: (data: unknown, msg?: string) => void;
    warn: (data: unknown, msg?: string) => void;
    error: (data: unknown, msg?: string) => void;
  };
}

/**
 * Run the extraction pipeline for one document end-to-end. Used by the
 * worker process; the API process never calls this directly. Always
 * resolves — failures are persisted into documents.extraction_error
 * rather than thrown so the worker loop can move to the next job.
 *
 * Pre-flight responsibilities pulled out of the old fire-and-forget
 * trigger:
 *   1. Reject docs larger than MAX_EXTRACT_BYTES with a clear error.
 *   2. For structured_procedure docs, synthesize a markdown body from
 *      procedure_steps so the chunker has something to grind on.
 *   3. Capture the doc's prior extracted text so section re-validation
 *      can compare old vs new per-page Jaccard.
 *
 * Post-flight: re-validate document_sections when extraction succeeds.
 */
export async function runExtraction(
  ctx: ExtractionContext,
  documentId: string,
): Promise<void> {
  const { db, storage } = ctx;
  const log = ctx.log ?? consoleLogShim();
  const startedAt = Date.now();
  log.info({ documentId }, 'extraction pipeline starting');

  try {
    const priorDoc = await db.query.documents.findFirst({
      where: eq(schema.documents.id, documentId),
      columns: {
        extractedText: true,
        kind: true,
        bodyMarkdown: true,
        title: true,
        sizeBytes: true,
      },
    });
    const oldExtractedText = priorDoc?.extractedText ?? null;

    if (priorDoc?.sizeBytes && priorDoc.sizeBytes > MAX_EXTRACT_BYTES) {
      const mb = (priorDoc.sizeBytes / 1024 / 1024).toFixed(1);
      const capMb = (MAX_EXTRACT_BYTES / 1024 / 1024).toFixed(0);
      await db
        .update(schema.documents)
        .set({
          extractionStatus: 'failed',
          extractionError: `File too large for extraction (${mb} MB; cap is ${capMb} MB). The document is still viewable, but it isn't AI-indexed.`,
        })
        .where(eq(schema.documents.id, documentId));
      log.warn({ documentId, sizeBytes: priorDoc.sizeBytes }, 'extraction skipped: file exceeds size cap');
      return;
    }

    if (priorDoc?.kind === 'structured_procedure') {
      const synthesized = await synthesizeProcedureMarkdown(
        db,
        documentId,
        priorDoc.title ?? 'Untitled procedure',
      );
      if (synthesized.trim().length > 0) {
        await db
          .update(schema.documents)
          .set({ bodyMarkdown: synthesized })
          .where(eq(schema.documents.id, documentId));
      }
    }

    const result = await processDocument({
      db,
      documentId,
      fetchFileStream: (k) => openFileStream(storage, k),
      publicUrl: (k) => storage.publicUrl(k),
      // PPTX slide-image rendering. The worker has access to storage,
      // so we bind the put-png callback here and let the pipeline call
      // it once per slides document. Errors inside this callback only
      // affect slide_decks.conversion_status — text extraction status
      // is independent.
      renderSlides: async ({ pptxPath, documentId: docId, ownerOrganizationId }) => {
        const speakerNotes = await readSpeakerNotesFromPptx(pptxPath);
        await convertPptxToSlideImages({
          db,
          pptxPath,
          documentId: docId,
          ownerOrganizationId,
          speakerNotesBySlide: speakerNotes,
          putPng: async ({ buffer, filename, ownerOrganizationId: org }) => {
            const out = await storage.putBuffer({
              buffer,
              filename,
              contentType: 'image/png',
              ownerOrganizationId: org,
            });
            return { storageKey: out.storageKey };
          },
          log: {
            info: (d, m) => log.info(typeof d === 'object' ? (d as object) : { d }, m),
            warn: (d, m) => log.warn(typeof d === 'object' ? (d as object) : { d }, m),
            error: (d, m) => log.error(typeof d === 'object' ? (d as object) : { d }, m),
          },
        });
      },
    });
    const ms = Date.now() - startedAt;
    log.info(
      { documentId, ms, status: result.status, chunks: result.chunksWritten },
      'extraction pipeline completed',
    );

    if (result.status === 'ready' || result.status === 'not_applicable') {
      try {
        const summary = await revalidateDocumentSections({
          db,
          documentId,
          oldExtractedText,
        });
        if (summary.total > 0) {
          log.info(
            {
              documentId,
              total: summary.total,
              accepted: summary.accepted,
              flagged: summary.flagged,
              skipped: summary.skipped,
            },
            'document_sections re-validated',
          );
        }
      } catch (revalErr) {
        log.error(
          { err: revalErr, documentId },
          'document_sections re-validation threw — sections left in prior state',
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, documentId }, 'extraction pipeline threw');
    try {
      await db
        .update(schema.documents)
        .set({ extractionStatus: 'failed', extractionError: msg })
        .where(eq(schema.documents.id, documentId));
    } catch (writeErr) {
      log.error({ err: writeErr, documentId }, 'failed to persist extraction failure');
    }
  }
}

function consoleLogShim() {
  return {
    info: (data: unknown, msg?: string) =>
      console.log(JSON.stringify({ level: 'info', ...(typeof data === 'object' && data !== null ? data : { data }), msg })),
    warn: (data: unknown, msg?: string) =>
      console.warn(JSON.stringify({ level: 'warn', ...(typeof data === 'object' && data !== null ? data : { data }), msg })),
    error: (data: unknown, msg?: string) =>
      console.error(JSON.stringify({ level: 'error', ...(typeof data === 'object' && data !== null ? data : { data }), msg })),
  };
}
