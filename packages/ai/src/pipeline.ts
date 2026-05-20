// Extraction pipeline orchestrator.
//
// Takes a single document through: download → extract → chunk → embed →
// upsert chunks → update status. The whole thing is idempotent (safe to
// re-run on the same document), handles partial failures gracefully, and
// reports progress via the documents.extractionStatus column so the admin
// UI can surface state without a separate job queue.
//
// Storage access is injected as a callback — the ai package stays free of
// S3 / R2 coupling so it can be reused against any storage backend.

import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { extract, isExtractable, ExtractionError } from './extract/index.js';
import { chunkMarkdown, DEFAULT_CHUNK_OPTIONS } from './chunking.js';
import { embedBatch } from './embeddings.js';

export interface PipelineParams {
  db: Database;
  documentId: string;
  /** Open a readable stream for the source file in storage. The pipeline
   *  pipes it to a temp file on disk so the PDF extractor can split large
   *  documents via qpdf without buffering them in RAM. The pipeline owns
   *  the temp file lifecycle (cleaned up on success and failure). */
  fetchFileStream: (storageKey: string) => Promise<NodeJS.ReadableStream>;
}

export interface PipelineResult {
  status: 'ready' | 'failed' | 'not_applicable';
  chunksWritten: number;
  qualityScore?: number;
  notes?: string[];
  error?: string;
}

/**
 * Process one document end-to-end. Always resolves; failures are surfaced as
 * `{ status: 'failed', error }` rather than thrown so callers can loop over
 * many docs without bailing on the first error.
 */
export async function processDocument(params: PipelineParams): Promise<PipelineResult> {
  const { db, documentId, fetchFileStream } = params;

  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, documentId),
  });
  if (!doc) {
    return { status: 'failed', chunksWritten: 0, error: 'document not found' };
  }

  // Markdown-native docs don't need extraction — they chunk directly from
  // bodyMarkdown. External videos don't chunk at all.
  if (doc.kind === 'markdown' || doc.kind === 'structured_procedure') {
    return await processMarkdownDocument(db, doc);
  }
  if (doc.kind === 'external_video' || doc.kind === 'video') {
    await markStatus(db, documentId, 'not_applicable');
    return { status: 'not_applicable', chunksWritten: 0 };
  }
  if (!isExtractable(doc.kind, doc.contentType)) {
    await markStatus(db, documentId, 'not_applicable');
    return { status: 'not_applicable', chunksWritten: 0 };
  }
  if (!doc.storageKey) {
    const msg = 'storage key missing — nothing to extract';
    await markFailed(db, documentId, msg);
    return { status: 'failed', chunksWritten: 0, error: msg };
  }

  // Mark processing so the UI can poll and a second concurrent call sees state.
  await markStatus(db, documentId, 'processing');

  // Stream the source from object storage into a per-doc temp directory.
  // The PDF extractor reads pages off this file via qpdf without ever
  // loading the whole document into JS memory — that's what lets us
  // process 100MB+ PDFs on a 1GB Fly box. The temp dir is removed in a
  // finally block so a crash or thrown error doesn't leak disk space.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-'));
  const sourceFilename = sanitizeFilename(doc.originalFilename) ?? 'source';
  const sourcePath = path.join(tempDir, sourceFilename);
  try {
    const readable = await fetchFileStream(doc.storageKey);
    await streamPipeline(readable, createWriteStream(sourcePath));

    const extraction = await extract({
      filePath: sourcePath,
      kind: doc.kind,
      contentType: doc.contentType,
      filename: doc.originalFilename,
    });

    const chunks = chunkMarkdown(extraction.markdown, {
      ...DEFAULT_CHUNK_OPTIONS,
      documentTitle: doc.title,
      pages: extraction.pages,
    });

    // Phase 1: save the extracted markdown immediately. This is the most
    // valuable artifact — admin section authoring (text-range picker) only
    // needs this, not embeddings. By committing it before attempting
    // embeddings, a Voyage rate-limit or transient outage doesn't mark the
    // doc as failed when the hard work succeeded.
    await db
      .update(schema.documents)
      .set({
        extractionStatus: 'ready',
        extractionError: null,
        extractedText: extraction.markdown,
        extractedAt: new Date(),
      })
      .where(eq(schema.documents.id, documentId));

    // Phase 2 (best-effort): embed chunks, swap them in atomically. A failure
    // here leaves the doc in 'ready' state with a soft warning — chat/RAG
    // won't have new vectors for this doc until the next reprocess, but
    // sections + the admin doc detail page still work.
    let chunksWritten = 0;
    let embedNotes: string[] = [];
    try {
      const embeddings =
        chunks.length > 0
          ? await embedBatch(
              chunks.map((c) => c.content),
              'document',
            )
          : [];

      if (embeddings.length !== chunks.length) {
        throw new Error(
          `embedding count mismatch: ${embeddings.length} vectors for ${chunks.length} chunks`,
        );
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(schema.documentChunks)
          .where(eq(schema.documentChunks.documentId, documentId));

        if (chunks.length > 0) {
          await tx.insert(schema.documentChunks).values(
            chunks.map((c, i) => ({
              documentId,
              contentPackVersionId: doc.contentPackVersionId,
              chunkIndex: i,
              content: c.content,
              charStart: c.charStart,
              charEnd: c.charEnd,
              page: c.page,
              embedding: embeddings[i]!,
              metadata: {
                sectionPath: c.sectionPath,
                rawContent: c.rawContent,
              },
            })),
          );
        }
      });
      chunksWritten = chunks.length;
    } catch (embedErr) {
      const embedMsg = formatError(embedErr);
      embedNotes = [
        `embeddings deferred: ${embedMsg}`,
        'Document is fully usable for section authoring; chat/RAG retrieval against this doc will be empty until the next reprocess succeeds.',
      ];
      // Surface the soft warning in extractionError without flipping status.
      // Admin UI only treats extractionError as fatal when status is 'failed'.
      await db
        .update(schema.documents)
        .set({
          extractionError: `embeddings deferred — ${embedMsg}`,
        })
        .where(eq(schema.documents.id, documentId));
    }

    return {
      status: 'ready',
      chunksWritten,
      qualityScore: extraction.meta.quality,
      notes: [...extraction.meta.notes, ...embedNotes],
    };
  } catch (err) {
    const msg = err instanceof ExtractionError ? err.message : formatError(err);
    await markFailed(db, documentId, msg);
    return { status: 'failed', chunksWritten: 0, error: msg };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Strip path separators and weird characters from a user-supplied filename
 *  before using it as a temp-file name. Returns null when the input has no
 *  usable characters left — callers fall back to a generic name. */
function sanitizeFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : null;
}

async function processMarkdownDocument(
  db: Database,
  doc: typeof schema.documents.$inferSelect,
): Promise<PipelineResult> {
  if (!doc.bodyMarkdown || doc.bodyMarkdown.trim().length === 0) {
    await markStatus(db, doc.id, 'not_applicable');
    return { status: 'not_applicable', chunksWritten: 0 };
  }

  await markStatus(db, doc.id, 'processing');

  try {
    const chunks = chunkMarkdown(doc.bodyMarkdown, {
      ...DEFAULT_CHUNK_OPTIONS,
      documentTitle: doc.title,
    });

    // Phase 1: save extractedText immediately, same rationale as the binary
    // extraction path — sections work off bodyMarkdown/extractedText, not
    // off embeddings.
    await db
      .update(schema.documents)
      .set({
        extractionStatus: 'ready',
        extractionError: null,
        extractedText: doc.bodyMarkdown,
        extractedAt: new Date(),
      })
      .where(eq(schema.documents.id, doc.id));

    // Phase 2 (best-effort): embed + write chunks.
    let chunksWritten = 0;
    try {
      const embeddings =
        chunks.length > 0
          ? await embedBatch(
              chunks.map((c) => c.content),
              'document',
            )
          : [];

      await db.transaction(async (tx) => {
        await tx
          .delete(schema.documentChunks)
          .where(eq(schema.documentChunks.documentId, doc.id));

        if (chunks.length > 0) {
          await tx.insert(schema.documentChunks).values(
            chunks.map((c, i) => ({
              documentId: doc.id,
              contentPackVersionId: doc.contentPackVersionId,
              chunkIndex: i,
              content: c.content,
              charStart: c.charStart,
              charEnd: c.charEnd,
              page: null,
              embedding: embeddings[i]!,
              metadata: {
                sectionPath: c.sectionPath,
                rawContent: c.rawContent,
              },
            })),
          );
        }
      });
      chunksWritten = chunks.length;
    } catch (embedErr) {
      const embedMsg = formatError(embedErr);
      await db
        .update(schema.documents)
        .set({
          extractionError: `embeddings deferred — ${embedMsg}`,
        })
        .where(eq(schema.documents.id, doc.id));
    }

    return { status: 'ready', chunksWritten, qualityScore: 1.0 };
  } catch (err) {
    const msg = formatError(err);
    await markFailed(db, doc.id, msg);
    return { status: 'failed', chunksWritten: 0, error: msg };
  }
}

async function markStatus(
  db: Database,
  documentId: string,
  status: 'pending' | 'processing' | 'ready' | 'not_applicable' | 'failed',
): Promise<void> {
  await db
    .update(schema.documents)
    .set({ extractionStatus: status, extractionError: null })
    .where(eq(schema.documents.id, documentId));
}

async function markFailed(db: Database, documentId: string, error: string): Promise<void> {
  await db
    .update(schema.documents)
    .set({ extractionStatus: 'failed', extractionError: error })
    .where(eq(schema.documents.id, documentId));
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message + (err.cause ? ` (cause: ${formatError(err.cause)})` : '');
  }
  return String(err);
}

/**
 * Enqueue all documents in a content pack version for (re)processing. Used
 * when a version is published — we want chunks + embeddings ready before
 * the PWA starts retrieving. Fires concurrently with a small pool limit.
 */
export async function processVersion(params: {
  db: Database;
  contentPackVersionId: string;
  fetchFileStream: (storageKey: string) => Promise<NodeJS.ReadableStream>;
  concurrency?: number;
}): Promise<PipelineResult[]> {
  const { db, contentPackVersionId, fetchFileStream, concurrency = 3 } = params;

  const docs = await db.query.documents.findMany({
    where: eq(schema.documents.contentPackVersionId, contentPackVersionId),
    columns: { id: true },
  });

  const results: PipelineResult[] = new Array(docs.length);
  let nextIdx = 0;
  const workers: Promise<void>[] = [];

  for (let w = 0; w < Math.min(concurrency, docs.length); w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const myIdx = nextIdx++;
          if (myIdx >= docs.length) return;
          results[myIdx] = await processDocument({
            db,
            documentId: docs[myIdx]!.id,
            fetchFileStream,
          });
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

// Re-export so callers can wire triggers without a second import.
export { isExtractable } from './extract/index.js';
