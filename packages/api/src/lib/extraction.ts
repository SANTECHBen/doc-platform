import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@platform/db';
import { processDocument } from '@platform/ai';
import { revalidateDocumentSections } from './section-revalidation-hook';
import { synthesizeProcedureMarkdown } from './synthesize-procedure-md';
import type { Storage } from '../storage';

// Open a readable stream against an object-storage key. The pipeline pipes
// this into a per-doc temp file so PDF extraction can split on disk via
// qpdf without holding the whole source PDF in RAM.
async function openFileStream(
  storage: Storage,
  storageKey: string,
): Promise<NodeJS.ReadableStream> {
  const result = await storage.stream(storageKey);
  if (!result) throw new Error(`File not found in storage: ${storageKey}`);
  return result.stream;
}

// Loose ceiling on doc size — PDF extraction is delegated to LlamaParse
// (which has its own per-plan size limits, currently 50-100 MB), so this
// cap mostly catches accidentally-uploaded gigabyte files. LlamaParse's
// own 4xx response gives a clean error for anything within its limits but
// over the plan size.
const MAX_EXTRACT_BYTES = 250 * 1024 * 1024;

// Fire-and-forget extraction. We deliberately don't block the HTTP response
// on processing — extraction can take 5–30s for large PDFs. The admin UI
// polls documents.extractionStatus to show progress. Errors are captured
// into the document row, not thrown, so the process won't exit.
//
// Extra defensiveness: wrap everything in an IIFE with its own try/catch
// and write failures back to the row. Without this, an error thrown during
// module init or a sync exception path could escape processDocument's
// internal try/catch and kill the Node process.
export function triggerExtraction(app: FastifyInstance, documentId: string): void {
  const { db, storage } = app.ctx;
  const startedAt = Date.now();
  app.log.info({ documentId }, 'extraction pipeline starting');

  (async () => {
    try {
      // Capture the doc's prior extracted text BEFORE processDocument
      // overwrites it. Section re-validation needs both old and new strings
      // to do per-page Jaccard comparison.
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

      // Soft ceiling — see MAX_EXTRACT_BYTES comment. Streaming PDF
      // extraction handles 100MB+ comfortably now, but a 5 GB upload
      // would still grind. Reject with a clear message above this.
      if (priorDoc?.sizeBytes && priorDoc.sizeBytes > MAX_EXTRACT_BYTES) {
        const mb = (priorDoc.sizeBytes / 1024 / 1024).toFixed(1);
        const capMb = (MAX_EXTRACT_BYTES / 1024 / 1024).toFixed(0);
        await db
          .update(schema.documents)
          .set({
            extractionStatus: 'failed',
            extractionError: `File too large for in-process extraction (${mb} MB; cap is ${capMb} MB). The document is still viewable, but it isn't AI-indexed. Split the file or shrink it before retrying.`,
          })
          .where(eq(schema.documents.id, documentId));
        app.log.warn(
          { documentId, sizeBytes: priorDoc.sizeBytes },
          'extraction skipped: file exceeds size cap',
        );
        return;
      }

      // Field-authored procedures store their content in procedure_steps,
      // not in documents.bodyMarkdown. The pipeline's processMarkdownDocument
      // only chunks bodyMarkdown — without a synthesized body, the doc lands
      // in extractionStatus='not_applicable' with zero chunks and is invisible
      // to the chat retriever.
      //
      // Always re-synthesize for structured_procedure docs (not just when
      // bodyMarkdown is empty): step titles/bodies/safety flags get edited
      // post-finalize, and we need every reprocess to pick up those edits.
      // Legacy hand-authored markdown procedures (no procedure_steps rows)
      // get an empty synthesis result, which we skip to avoid clobbering
      // their author's bodyMarkdown.
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
        // For PDFs, the LlamaParse path hands the storage URL directly
        // to LlamaParse so they fetch from R2 without our process ever
        // holding the bytes. We pass null when the env doesn't have a
        // public URL (e.g., dev with the local fs adapter) — extractPdf
        // then falls back to the buffered upload path.
        publicUrl: (k) => storage.publicUrl(k),
      });
      const ms = Date.now() - startedAt;
      app.log.info(
        { documentId, ms, status: result.status, chunks: result.chunksWritten },
        'extraction pipeline completed',
      );

      // After a successful (or not-applicable, e.g. video) extraction, re-
      // validate any document_sections against the new content. We do this
      // for 'ready' AND 'not_applicable' so that adding a new section to a
      // video resolves immediately.
      if (result.status === 'ready' || result.status === 'not_applicable') {
        try {
          const summary = await revalidateDocumentSections({
            db,
            documentId,
            oldExtractedText,
          });
          if (summary.total > 0) {
            app.log.info(
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
          app.log.error(
            { err: revalErr, documentId },
            'document_sections re-validation threw — sections left in prior state',
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, documentId }, 'extraction pipeline threw');
      // Best-effort: mark the doc failed so the UI can show a real error
      // instead of leaving it stuck at 'processing'.
      try {
        await db
          .update(schema.documents)
          .set({ extractionStatus: 'failed', extractionError: msg })
          .where(eq(schema.documents.id, documentId));
      } catch (writeErr) {
        app.log.error({ err: writeErr, documentId }, 'failed to persist extraction failure');
      }
    }
  })();
}
