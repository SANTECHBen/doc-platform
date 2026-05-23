// One-shot backfill for search_index_items.
//
// Marks every existing procedure_step and document_section row with
// search_index_stale_at = now() so the sweeper picks them up on the next
// API boot. For doc_chunk rows, walks every document_chunks row and
// upserts into search_index_items via indexDocChunkBatch — this path
// doesn't have a per-row dirty bit because chunks are re-allocated on
// re-extraction.
//
// Run once per environment, after 0032 has migrated. From the monorepo root:
//
//   DATABASE_URL=postgres://... pnpm -F @platform/api exec tsx scripts/backfill-search-index.ts
//
// Safe to re-run. Each procedure_step / document_section just bumps the
// dirty bit; each doc_chunk upsert is content-hash dedup'd.

import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { schema, type Database } from '@platform/db';
import { indexDocChunkBatch } from '@platform/ai';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema }) as unknown as Database;

async function markProcedureStepsStale(): Promise<number> {
  const result = await db.execute(
    sql`UPDATE procedure_steps
        SET search_index_stale_at = now()
        WHERE search_index_stale_at IS NULL`,
  );
  // postgres-js returns Result with count on the array form. drizzle's
  // execute wraps it; cast to any for the count field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = (result as any).count ?? 0;
  console.log(`[backfill] procedure_steps: marked ${count} rows stale`);
  return Number(count);
}

async function markDocumentSectionsStale(): Promise<number> {
  const result = await db.execute(
    sql`UPDATE document_sections
        SET search_index_stale_at = now()
        WHERE search_index_stale_at IS NULL`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const count = (result as any).count ?? 0;
  console.log(`[backfill] document_sections: marked ${count} rows stale`);
  return Number(count);
}

async function reindexAllDocChunks(): Promise<number> {
  // Group existing chunks by document, then call indexDocChunkBatch per
  // document so the indexer's wipe-and-replace logic does the right thing
  // (it removes prior doc_chunk rows for the document and reinserts).
  const allChunks = await db.query.documentChunks.findMany({
    columns: { id: true, documentId: true, content: true, chunkIndex: true },
    orderBy: schema.documentChunks.documentId,
  });
  const byDoc = new Map<
    string,
    Array<{ id: string; content: string; chunkIndex: number }>
  >();
  for (const c of allChunks) {
    const arr = byDoc.get(c.documentId) ?? [];
    arr.push({ id: c.id, content: c.content, chunkIndex: c.chunkIndex });
    byDoc.set(c.documentId, arr);
  }
  let totalChunks = 0;
  let docsDone = 0;
  for (const [docId, chunks] of byDoc.entries()) {
    chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    try {
      await indexDocChunkBatch(db, docId, chunks);
      totalChunks += chunks.length;
      docsDone += 1;
      if (docsDone % 25 === 0) {
        console.log(
          `[backfill] doc_chunks: ${docsDone} docs / ${totalChunks} chunks done`,
        );
      }
    } catch (err) {
      console.warn(`[backfill] doc_chunks: doc ${docId} failed:`, err);
    }
  }
  console.log(
    `[backfill] doc_chunks: indexed ${totalChunks} chunks across ${docsDone} documents`,
  );
  return totalChunks;
}

async function main(): Promise<void> {
  console.log('[backfill] starting');
  await markProcedureStepsStale();
  await markDocumentSectionsStale();
  await reindexAllDocChunks();
  console.log('[backfill] done. The API sweeper will embed staged rows over the next few minutes.');
}

await main();
await client.end();
process.exit(0);
