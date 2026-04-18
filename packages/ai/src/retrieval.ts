import { sql } from 'drizzle-orm';
import type { Database } from '@platform/db';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  contentPackVersionId: string;
  content: string;
  charStart: number | null;
  charEnd: number | null;
  page: number | null;
  score: number;
}

export interface Retriever {
  /**
   * Retrieve the top-k most relevant chunks, scoped to a specific
   * ContentPackVersion (and optionally layered overlay versions).
   *
   * Scoping is mandatory — grounding must never leak across tenants or versions.
   */
  retrieve(input: {
    query: string;
    contentPackVersionIds: string[];
    topK: number;
  }): Promise<RetrievedChunk[]>;
}

/**
 * Postgres full-text search retriever. Works without a separate embedding API —
 * good enough for small corpora (~hundreds of chunks) and as a cold-start fallback
 * before embeddings are populated. Swap to the pgvector retriever once the
 * embedding pipeline is online.
 */
export function createPgTextSearchRetriever(params: { db: Database }): Retriever {
  const { db } = params;
  return {
    async retrieve({ query, contentPackVersionIds, topK }) {
      if (contentPackVersionIds.length === 0) return [];
      // Encode the ID list as a Postgres array literal and cast server-side.
      // postgres-js can pass JS arrays, but behavior varies by driver version;
      // the explicit literal sidesteps that.
      const idsLiteral = `{${contentPackVersionIds.join(',')}}`;

      const rows = (await db.execute(
        sql`SELECT id, document_id, content_pack_version_id, content,
                 char_start, char_end, page,
                 ts_rank(to_tsvector('english', content),
                         websearch_to_tsquery('english', ${query})) AS score
            FROM document_chunks
            WHERE content_pack_version_id = ANY(${idsLiteral}::uuid[])
              AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${query})
            ORDER BY score DESC
            LIMIT ${topK}`,
      )) as unknown as Array<{
        id: string;
        document_id: string;
        content_pack_version_id: string;
        content: string;
        char_start: number | null;
        char_end: number | null;
        page: number | null;
        score: number;
      }>;

      // If FTS found nothing (e.g., stopword-only query), fall back to returning
      // the first N chunks of the pinned version so the model has *something* to
      // ground on. This keeps the demo usable with bare-word questions.
      if (rows.length === 0) {
        const fallback = (await db.execute(
          sql`SELECT id, document_id, content_pack_version_id, content,
                   char_start, char_end, page, 0::float AS score
              FROM document_chunks
              WHERE content_pack_version_id = ANY(${idsLiteral}::uuid[])
              ORDER BY chunk_index
              LIMIT ${topK}`,
        )) as unknown as typeof rows;
        return fallback.map(mapRow);
      }

      return rows.map(mapRow);
    },
  };
}

function mapRow(r: {
  id: string;
  document_id: string;
  content_pack_version_id: string;
  content: string;
  char_start: number | null;
  char_end: number | null;
  page: number | null;
  score: number;
}): RetrievedChunk {
  return {
    id: r.id,
    documentId: r.document_id,
    contentPackVersionId: r.content_pack_version_id,
    content: r.content,
    charStart: r.char_start,
    charEnd: r.char_end,
    page: r.page,
    score: Number(r.score),
  };
}

/**
 * Concrete retriever using pgvector. The embedding call is pluggable so we can
 * swap embedders (voyage-3 → voyage-3-large etc.) without touching the retriever.
 */
export function createPgVectorRetriever(params: {
  db: Database;
  embed: (text: string) => Promise<number[]>;
}): Retriever {
  const { db, embed } = params;
  return {
    async retrieve({ query, contentPackVersionIds, topK }) {
      if (contentPackVersionIds.length === 0) return [];

      const queryEmbedding = await embed(query);
      // Cosine distance via pgvector `<=>` operator; lower is more similar.
      // Parameterized to avoid SQL injection even though IDs are UUIDs.
      const vectorLiteral = `[${queryEmbedding.join(',')}]`;

      // drizzle-orm has a `sql` template — the consumer (api package) will wire
      // this to an actual query. We intentionally keep this package free of
      // direct schema coupling so the retriever contract is reusable.
      const rows = await (db as any).execute(
        `SELECT id, document_id, content_pack_version_id, content,
                char_start, char_end, page,
                (embedding <=> $1::vector) AS score
         FROM document_chunks
         WHERE content_pack_version_id = ANY($2::uuid[])
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [vectorLiteral, contentPackVersionIds, topK],
      );

      return (rows as any[]).map((r) => ({
        id: r.id,
        documentId: r.document_id,
        contentPackVersionId: r.content_pack_version_id,
        content: r.content,
        charStart: r.char_start,
        charEnd: r.char_end,
        page: r.page,
        score: Number(r.score),
      }));
    },
  };
}
