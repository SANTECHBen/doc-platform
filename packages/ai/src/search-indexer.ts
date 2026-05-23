// Search index writer — populates search_index_items from the three source
// tables (document_chunks, procedure_steps, document_sections).
//
// Lazy re-embed semantics:
//   - PATCH on a source row sets its search_index_stale_at = now().
//   - The 60-second sweeper picks up rows where the source's
//     search_index_stale_at exceeds the index row's embedded_at (or the
//     index row is missing entirely), recomputes the canonical text, and
//     calls Voyage only when content_hash changed.
//
// Content hash check is the cost lever — Voyage charges per token, and
// re-embedding an unchanged step on every PATCH (e.g., a media-only edit)
// would compound quickly across a procedure library.

import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import {
  schema,
  type Database,
  type SearchSourceType,
  type StepBlock,
} from '@platform/db';
import { embedBatch } from './embeddings.js';

// ---------------------------------------------------------------------------
// Content extraction per source type
// ---------------------------------------------------------------------------

/** Flatten a step's typed blocks into searchable plain text. Mirrors the
 *  text the PWA renders, minus formatting. */
function blocksToPlainText(blocks: StepBlock[] | null | undefined): string {
  if (!blocks || blocks.length === 0) return '';
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'paragraph':
        out.push(b.text);
        break;
      case 'callout':
        out.push(`${b.title ? b.title + ': ' : ''}${b.text}`);
        break;
      case 'bullet_list':
      case 'numbered_list':
        out.push(b.items.join('\n'));
        break;
      case 'key_value':
        out.push(b.rows.map((row: [string, string]) => `${row[0]}: ${row[1]}`).join('\n'));
        break;
      case 'photo_inline':
        if (b.caption) out.push(b.caption);
        break;
    }
  }
  return out.join('\n');
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Indexers per source type
// ---------------------------------------------------------------------------

interface IndexResult {
  /** True when Voyage was called (content changed or new row). False when
   *  the existing embedding was reused via content-hash short-circuit. */
  embedded: boolean;
  /** False when the source row no longer qualifies (deleted, kind change,
   *  etc.) and any existing index row was removed. */
  written: boolean;
}

export async function indexProcedureStep(
  db: Database,
  stepId: string,
): Promise<IndexResult> {
  const step = await db.query.procedureSteps.findFirst({
    where: eq(schema.procedureSteps.id, stepId),
    with: {
      document: {
        with: { packVersion: { with: { pack: true } } },
      },
      section: true,
      snippet: true,
    },
  });
  if (!step || !step.document) {
    await deleteIndexRow(db, 'procedure_step', stepId);
    return { embedded: false, written: false };
  }
  const doc = step.document;
  const pack = doc.packVersion?.pack;
  if (!pack) {
    await deleteIndexRow(db, 'procedure_step', stepId);
    return { embedded: false, written: false };
  }
  // Snippet-attached steps: resolve current snippet content so the index
  // matches what the runner shows.
  const blocks: StepBlock[] =
    step.snippetId && !step.snippetDetached && step.snippet
      ? step.snippet.blocks
      : step.blocks ?? [];
  const effectiveTitle =
    step.snippetId && !step.snippetDetached && step.snippet && (!step.title || step.title.length === 0)
      ? step.snippet.title
      : step.title;

  // Canonical search text. Prepend safety + section + doc title so the
  // chunk's contextual signal stays high even when the step's own title
  // is short. Mirrors the chunker's contextual-prepend pattern.
  const safetyPrefix = step.safetyCritical ? 'SAFETY: ' : '';
  const docTitle = doc.title || '';
  const sectionTitle = step.section?.title ?? '';
  const bodyText = blocksToPlainText(blocks);
  const content =
    `${docTitle}${sectionTitle ? ' → ' + sectionTitle : ''}\n\n` +
    `${safetyPrefix}${effectiveTitle || '(untitled step)'}` +
    (bodyText ? `\n${bodyText}` : '');

  const result = await upsertIndex(db, {
    contentPackVersionId: doc.contentPackVersionId,
    documentId: doc.id,
    ownerOrganizationId: pack.ownerOrganizationId,
    sourceType: 'procedure_step',
    sourceId: step.id,
    title: effectiveTitle || '(untitled step)',
    content,
    metadata: {
      docTitle,
      sectionTitle,
      sectionId: step.sectionId,
      orderingHint: step.orderingHint,
      safetyCritical: step.safetyCritical,
      kind: step.kind,
    },
  });
  // Clear the dirty bit on the source row. Done after the upsert so a
  // failure leaves the row stale and the sweeper will retry.
  await db
    .update(schema.procedureSteps)
    .set({ searchIndexStaleAt: null })
    .where(eq(schema.procedureSteps.id, step.id));
  return result;
}

export async function indexDocumentSection(
  db: Database,
  sectionId: string,
): Promise<IndexResult> {
  const section = await db.query.documentSections.findFirst({
    where: eq(schema.documentSections.id, sectionId),
    with: {
      document: { with: { packVersion: { with: { pack: true } } } },
    },
  });
  if (!section || !section.document) {
    await deleteIndexRow(db, 'document_section', sectionId);
    return { embedded: false, written: false };
  }
  const doc = section.document;
  const pack = doc.packVersion?.pack;
  if (!pack) {
    await deleteIndexRow(db, 'document_section', sectionId);
    return { embedded: false, written: false };
  }

  const docTitle = doc.title || '';
  const excerpt = section.anchorExcerpt ?? '';
  const content = `${docTitle}\n\n${section.title}${
    section.description ? '\n' + section.description : ''
  }${excerpt ? '\n\n' + excerpt : ''}`;

  const result = await upsertIndex(db, {
    contentPackVersionId: doc.contentPackVersionId,
    documentId: doc.id,
    ownerOrganizationId: pack.ownerOrganizationId,
    sourceType: 'document_section',
    sourceId: section.id,
    title: section.title,
    content,
    metadata: {
      docTitle,
      kind: section.kind,
      pageStart: section.pageStart ?? null,
      pageEnd: section.pageEnd ?? null,
      timeStartSeconds: section.timeStartSeconds ?? null,
      timeEndSeconds: section.timeEndSeconds ?? null,
    },
  });
  await db
    .update(schema.documentSections)
    .set({ searchIndexStaleAt: null })
    .where(eq(schema.documentSections.id, section.id));
  return result;
}

/**
 * Mirror an extraction-pipeline chunk write into search_index_items. Called
 * from packages/ai/src/pipeline.ts after document_chunks is populated.
 * Unlike step/section indexing, chunks never become stale individually —
 * a re-extraction wipes-and-reinserts the full set.
 */
export async function indexDocChunkBatch(
  db: Database,
  documentId: string,
  chunks: Array<{ id: string; content: string; chunkIndex: number }>,
): Promise<void> {
  if (chunks.length === 0) return;
  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, documentId),
    with: { packVersion: { with: { pack: true } } },
  });
  if (!doc || !doc.packVersion?.pack) return;
  const pack = doc.packVersion.pack;
  const docTitle = doc.title || '';

  // Clear stale doc_chunk rows for this version + document — the chunker
  // re-allocates ids, so the previous set is no longer addressable.
  await db
    .delete(schema.searchIndexItems)
    .where(
      and(
        eq(schema.searchIndexItems.contentPackVersionId, doc.contentPackVersionId),
        eq(schema.searchIndexItems.documentId, doc.id),
        eq(schema.searchIndexItems.sourceType, 'doc_chunk'),
      ),
    );

  for (const chunk of chunks) {
    await upsertIndex(db, {
      contentPackVersionId: doc.contentPackVersionId,
      documentId: doc.id,
      ownerOrganizationId: pack.ownerOrganizationId,
      sourceType: 'doc_chunk',
      sourceId: chunk.id,
      title: docTitle,
      content: chunk.content,
      metadata: { docTitle, chunkIndex: chunk.chunkIndex },
    });
  }
}

// ---------------------------------------------------------------------------
// Upsert + delete primitives
// ---------------------------------------------------------------------------

interface UpsertParams {
  contentPackVersionId: string;
  documentId: string | null;
  ownerOrganizationId: string;
  sourceType: SearchSourceType;
  sourceId: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

async function upsertIndex(db: Database, p: UpsertParams): Promise<IndexResult> {
  const contentHash = hashContent(p.content);
  const existing = await db.query.searchIndexItems.findFirst({
    where: and(
      eq(schema.searchIndexItems.contentPackVersionId, p.contentPackVersionId),
      eq(schema.searchIndexItems.sourceType, p.sourceType),
      eq(schema.searchIndexItems.sourceId, p.sourceId),
    ),
  });

  // Hash unchanged + embedding already present → just refresh the metadata
  // / title fields without paying Voyage.
  if (existing && existing.contentHash === contentHash && existing.embedding) {
    await db
      .update(schema.searchIndexItems)
      .set({
        title: p.title,
        metadata: p.metadata,
        updatedAt: new Date(),
      })
      .where(eq(schema.searchIndexItems.id, existing.id));
    return { embedded: false, written: true };
  }

  // Need an embedding. Single-item embed — callers that have many items
  // should use embedBatch directly via reindexStale's batch path below.
  const [embedding] = await embedBatch([p.content], 'document');
  if (!embedding) {
    throw new Error('Voyage returned no embedding for upsertIndex');
  }

  if (existing) {
    await db
      .update(schema.searchIndexItems)
      .set({
        title: p.title,
        content: p.content,
        contentHash,
        embedding,
        metadata: p.metadata,
        embeddedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.searchIndexItems.id, existing.id));
  } else {
    await db.insert(schema.searchIndexItems).values({
      contentPackVersionId: p.contentPackVersionId,
      documentId: p.documentId,
      ownerOrganizationId: p.ownerOrganizationId,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      title: p.title,
      content: p.content,
      contentHash,
      embedding,
      metadata: p.metadata,
      embeddedAt: new Date(),
    });
  }
  return { embedded: true, written: true };
}

export async function deleteIndexRow(
  db: Database,
  sourceType: SearchSourceType,
  sourceId: string,
): Promise<void> {
  await db
    .delete(schema.searchIndexItems)
    .where(
      and(
        eq(schema.searchIndexItems.sourceType, sourceType),
        eq(schema.searchIndexItems.sourceId, sourceId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Sweeper — picks up stale rows and re-embeds them in batches.
// ---------------------------------------------------------------------------

export interface ReindexStaleResult {
  scanned: number;
  embedded: number;
  failed: number;
}

/**
 * Scan source tables for rows whose `search_index_stale_at` is non-null and
 * either newer than the corresponding index row's `embedded_at` or the
 * index row is missing. Re-embed up to `batchSize` of them. Designed to be
 * called from a 60-second interval on the API server.
 */
export async function reindexStale(
  db: Database,
  batchSize = 50,
): Promise<ReindexStaleResult> {
  const result: ReindexStaleResult = { scanned: 0, embedded: 0, failed: 0 };

  // Find stale procedure steps. We do this as a single query against the
  // source table; the indexer per row joins back to the index to compute
  // the hash short-circuit. Cheaper than a left-join here because the
  // expected stale-count per tick is small (single digits).
  const staleSteps = await db.query.procedureSteps.findMany({
    where: isNotNull(schema.procedureSteps.searchIndexStaleAt),
    columns: { id: true },
    limit: batchSize,
  });
  for (const s of staleSteps) {
    result.scanned += 1;
    try {
      const r = await indexProcedureStep(db, s.id);
      if (r.embedded) result.embedded += 1;
    } catch {
      result.failed += 1;
    }
  }

  const remaining = batchSize - staleSteps.length;
  if (remaining > 0) {
    const staleSections = await db.query.documentSections.findMany({
      where: isNotNull(schema.documentSections.searchIndexStaleAt),
      columns: { id: true },
      limit: remaining,
    });
    for (const s of staleSections) {
      result.scanned += 1;
      try {
        const r = await indexDocumentSection(db, s.id);
        if (r.embedded) result.embedded += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}
