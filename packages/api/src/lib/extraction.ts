import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@platform/db';
import { processDocument } from '@platform/ai';
import { revalidateDocumentSections } from './section-revalidation-hook';
import type { Storage } from '../storage';

// Pull a storage key into a Buffer. The extraction pipeline needs bytes in
// memory — file sizes are capped at upload (20 MB default) so this is fine.
async function fetchFileBuffer(storage: Storage, storageKey: string): Promise<Buffer> {
  const result = await storage.stream(storageKey);
  if (!result) throw new Error(`File not found in storage: ${storageKey}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

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
        columns: { extractedText: true },
      });
      const oldExtractedText = priorDoc?.extractedText ?? null;

      const result = await processDocument({
        db,
        documentId,
        fetchFile: (k) => fetchFileBuffer(storage, k),
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
