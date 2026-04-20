import { sql } from 'drizzle-orm';
import type { Database } from '@platform/db';
import { embed, rerank } from './embeddings.js';

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
 * Postgres full-text search retriever. Cheap, no external API calls, good
 * for keyword recall ("fault E-217", "grease fitting") where exact tokens
 * matter. Works before embeddings are populated and stays useful after —
 * hybrid retrieval benefits from both keyword and semantic signal.
 */
export function createPgTextSearchRetriever(params: { db: Database }): Retriever {
  const { db } = params;
  return {
    async retrieve({ query, contentPackVersionIds, topK }) {
      if (contentPackVersionIds.length === 0) return [];
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
      )) as unknown as RawRow[];

      if (rows.length === 0) {
        // FTS returned nothing (e.g., stopword-only query). Fall back to the
        // first N chunks of the pinned version so the model has something to
        // ground on. Keeps the UI useful for bare-word questions.
        const fallback = (await db.execute(
          sql`SELECT id, document_id, content_pack_version_id, content,
                   char_start, char_end, page, 0::float AS score
              FROM document_chunks
              WHERE content_pack_version_id = ANY(${idsLiteral}::uuid[])
              ORDER BY chunk_index
              LIMIT ${topK}`,
        )) as unknown as RawRow[];
        return fallback.map(mapRow);
      }

      return rows.map(mapRow);
    },
  };
}

/**
 * pgvector semantic retriever. Embeds the query with the caller-supplied
 * function, then runs cosine similarity (`<=>` operator) against the
 * document_chunks.embedding column. Returns `score` as raw distance
 * (lower = closer); the hybrid retriever normalizes this before fusion.
 */
export function createPgVectorRetriever(params: {
  db: Database;
  embed: (text: string) => Promise<number[]>;
}): Retriever {
  const { db, embed: embedFn } = params;
  return {
    async retrieve({ query, contentPackVersionIds, topK }) {
      if (contentPackVersionIds.length === 0) return [];

      const vec = await embedFn(query);
      const vectorLiteral = `[${vec.join(',')}]`;
      const idsLiteral = `{${contentPackVersionIds.join(',')}}`;

      const rows = (await db.execute(
        sql`SELECT id, document_id, content_pack_version_id, content,
                 char_start, char_end, page,
                 (embedding <=> ${vectorLiteral}::vector) AS score
            FROM document_chunks
            WHERE content_pack_version_id = ANY(${idsLiteral}::uuid[])
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vectorLiteral}::vector
            LIMIT ${topK}`,
      )) as unknown as RawRow[];

      return rows.map(mapRow);
    },
  };
}

interface HybridOptions {
  /** Candidates pulled from each leg before fusion. Default 30. */
  candidatesPerLeg?: number;
  /** Final top-K returned after rerank. */
  topK: number;
  /** RRF constant. 60 is the reference value from Cormack et al. (2009). */
  rrfK?: number;
  /** If true, skip Voyage rerank (useful for dev without an API key). */
  skipRerank?: boolean;
}

/**
 * Hybrid retriever — FTS + vectors merged via Reciprocal Rank Fusion, then
 * reranked by Voyage. This is the production retriever for the chat route.
 *
 * Why RRF over linear score blending: FTS returns ts_rank (unbounded positive)
 * and pgvector returns cosine distance (0–2). Normalizing them into a shared
 * scale is fragile. RRF throws away scores entirely and uses ranks, which
 * makes it robust to the scoring-unit mismatch and well-behaved when one leg
 * returns zero results.
 */
export function createHybridRetriever(params: {
  db: Database;
  options: HybridOptions;
}): Retriever {
  const { db, options } = params;
  const candidatesPerLeg = options.candidatesPerLeg ?? 30;
  const rrfK = options.rrfK ?? 60;

  const fts = createPgTextSearchRetriever({ db });
  const vec = createPgVectorRetriever({ db, embed: (q) => embed(q, 'query') });

  return {
    async retrieve({ query, contentPackVersionIds, topK: _ignoredTopK }) {
      if (contentPackVersionIds.length === 0) return [];

      // Run both legs in parallel. If vector search fails (e.g., VOYAGE_API_KEY
      // missing or all chunks unembedded), fall back gracefully to FTS alone.
      const [ftsResults, vecResults] = await Promise.all([
        fts.retrieve({ query, contentPackVersionIds, topK: candidatesPerLeg }),
        vec
          .retrieve({ query, contentPackVersionIds, topK: candidatesPerLeg })
          .catch(() => [] as RetrievedChunk[]),
      ]);

      const fused = reciprocalRankFusion(ftsResults, vecResults, rrfK);
      if (fused.length === 0) return [];

      // Second-stage rerank on the fused pool. Voyage sees the candidate
      // texts and the query together, so it can pick the ones that actually
      // answer — a big step up from pure lexical/vector similarity.
      if (options.skipRerank) {
        return fused.slice(0, options.topK);
      }

      try {
        const ranked = await rerank(
          query,
          fused.map((c) => c.content),
          options.topK,
        );
        return ranked.map((r) => {
          const base = fused[r.index]!;
          return { ...base, score: r.score };
        });
      } catch {
        // Rerank is a quality lever, not a correctness requirement. If it
        // fails (quota, network, bad key) we serve the RRF-fused list —
        // still better than single-leg retrieval.
        return fused.slice(0, options.topK);
      }
    },
  };
}

function reciprocalRankFusion(
  a: RetrievedChunk[],
  b: RetrievedChunk[],
  k: number,
): RetrievedChunk[] {
  const scoreById = new Map<string, { score: number; chunk: RetrievedChunk }>();
  const add = (rank: number, chunk: RetrievedChunk) => {
    const rrf = 1 / (k + rank);
    const prev = scoreById.get(chunk.id);
    if (prev) prev.score += rrf;
    else scoreById.set(chunk.id, { score: rrf, chunk });
  };
  a.forEach((c, i) => add(i + 1, c));
  b.forEach((c, i) => add(i + 1, c));

  return [...scoreById.values()]
    .sort((x, y) => y.score - x.score)
    .map(({ score, chunk }) => ({ ...chunk, score }));
}

interface RawRow {
  id: string;
  document_id: string;
  content_pack_version_id: string;
  content: string;
  char_start: number | null;
  char_end: number | null;
  page: number | null;
  score: number | string;
}

function mapRow(r: RawRow): RetrievedChunk {
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
