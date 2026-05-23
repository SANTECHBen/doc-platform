// Voice-search retriever — hybrid (FTS + pgvector) over search_index_items,
// reranked by Voyage. Parallel to packages/ai/src/retrieval.ts but reads
// from the unified search_index_items table instead of document_chunks,
// and returns rows that may be document chunks, procedure steps, or
// document sections.
//
// The caller is responsible for materializing a jump URL per hit (see
// packages/api/src/services/search-jump-url.ts) — keeping URL assembly out
// of the retriever lets the same retriever serve the admin search UX
// without depending on PWA route shapes.

import { sql } from 'drizzle-orm';
import type { Database, SearchSourceType } from '@platform/db';
import { embed, rerank } from './embeddings.js';

export interface SearchHit {
  id: string;
  sourceType: SearchSourceType;
  sourceId: string;
  documentId: string | null;
  contentPackVersionId: string;
  ownerOrganizationId: string;
  title: string;
  /** Up to ~300 chars of the indexed content for the result card snippet
   *  and reranker. The retriever truncates client-side after rerank. */
  content: string;
  metadata: Record<string, unknown>;
  /** Final rerank score (0..1). When rerank is skipped, this is the RRF
   *  fused score, which lies on a different scale — the UI should treat
   *  the value as ordinal only. */
  score: number;
}

interface RetrieveInput {
  query: string;
  /** Scope filter. Empty array short-circuits to no results. */
  contentPackVersionIds: string[];
  /** Org-level scope (defense in depth). Empty array short-circuits. */
  ownerOrganizationIds: string[];
  topK: number;
  /** Limit to specific source types. Default: all three. */
  sourceTypes?: SearchSourceType[];
}

export interface SearchRetriever {
  retrieve(input: RetrieveInput): Promise<SearchHit[]>;
}

// ---------------------------------------------------------------------------
// FTS leg
// ---------------------------------------------------------------------------

function createFtsRetriever(db: Database): SearchRetriever {
  return {
    async retrieve(input) {
      if (input.contentPackVersionIds.length === 0) return [];
      if (input.ownerOrganizationIds.length === 0) return [];
      const versionsLit = `{${input.contentPackVersionIds.join(',')}}`;
      const orgsLit = `{${input.ownerOrganizationIds.join(',')}}`;
      const sourcesLit = input.sourceTypes
        ? `{${input.sourceTypes.join(',')}}`
        : null;

      const rows = sourcesLit
        ? ((await db.execute(
            sql`SELECT id, source_type, source_id, document_id, content_pack_version_id,
                       owner_organization_id, title, content, metadata,
                       ts_rank(to_tsvector('english', content),
                               websearch_to_tsquery('english', ${input.query})) AS score
                FROM search_index_items
                WHERE content_pack_version_id = ANY(${versionsLit}::uuid[])
                  AND owner_organization_id   = ANY(${orgsLit}::uuid[])
                  AND source_type             = ANY(${sourcesLit}::search_source_type[])
                  AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${input.query})
                ORDER BY score DESC
                LIMIT ${input.topK}`,
          )) as unknown as RawRow[])
        : ((await db.execute(
            sql`SELECT id, source_type, source_id, document_id, content_pack_version_id,
                       owner_organization_id, title, content, metadata,
                       ts_rank(to_tsvector('english', content),
                               websearch_to_tsquery('english', ${input.query})) AS score
                FROM search_index_items
                WHERE content_pack_version_id = ANY(${versionsLit}::uuid[])
                  AND owner_organization_id   = ANY(${orgsLit}::uuid[])
                  AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${input.query})
                ORDER BY score DESC
                LIMIT ${input.topK}`,
          )) as unknown as RawRow[]);

      return rows.map(mapRow);
    },
  };
}

// ---------------------------------------------------------------------------
// Vector leg
// ---------------------------------------------------------------------------

function createVectorRetriever(db: Database): SearchRetriever {
  return {
    async retrieve(input) {
      if (input.contentPackVersionIds.length === 0) return [];
      if (input.ownerOrganizationIds.length === 0) return [];
      const vec = await embed(input.query, 'query');
      const vectorLit = `[${vec.join(',')}]`;
      const versionsLit = `{${input.contentPackVersionIds.join(',')}}`;
      const orgsLit = `{${input.ownerOrganizationIds.join(',')}}`;
      const sourcesLit = input.sourceTypes
        ? `{${input.sourceTypes.join(',')}}`
        : null;

      const rows = sourcesLit
        ? ((await db.execute(
            sql`SELECT id, source_type, source_id, document_id, content_pack_version_id,
                       owner_organization_id, title, content, metadata,
                       (embedding <=> ${vectorLit}::vector) AS score
                FROM search_index_items
                WHERE content_pack_version_id = ANY(${versionsLit}::uuid[])
                  AND owner_organization_id   = ANY(${orgsLit}::uuid[])
                  AND source_type             = ANY(${sourcesLit}::search_source_type[])
                  AND embedding IS NOT NULL
                ORDER BY embedding <=> ${vectorLit}::vector
                LIMIT ${input.topK}`,
          )) as unknown as RawRow[])
        : ((await db.execute(
            sql`SELECT id, source_type, source_id, document_id, content_pack_version_id,
                       owner_organization_id, title, content, metadata,
                       (embedding <=> ${vectorLit}::vector) AS score
                FROM search_index_items
                WHERE content_pack_version_id = ANY(${versionsLit}::uuid[])
                  AND owner_organization_id   = ANY(${orgsLit}::uuid[])
                  AND embedding IS NOT NULL
                ORDER BY embedding <=> ${vectorLit}::vector
                LIMIT ${input.topK}`,
          )) as unknown as RawRow[]);

      return rows.map(mapRow);
    },
  };
}

// ---------------------------------------------------------------------------
// Hybrid retriever — FTS ∪ pgvector via RRF, then Voyage rerank.
// ---------------------------------------------------------------------------

interface HybridOptions {
  candidatesPerLeg?: number;
  topK: number;
  rrfK?: number;
  /** Skip Voyage rerank (useful in dev w/o a key, or for cheap dropdown
   *  autocomplete-style search). */
  skipRerank?: boolean;
}

export function createSearchHybridRetriever(params: {
  db: Database;
  options: HybridOptions;
}): SearchRetriever {
  const { db, options } = params;
  const candidatesPerLeg = options.candidatesPerLeg ?? 30;
  const rrfK = options.rrfK ?? 60;

  const fts = createFtsRetriever(db);
  const vec = createVectorRetriever(db);

  return {
    async retrieve(input) {
      if (input.contentPackVersionIds.length === 0) return [];
      if (input.ownerOrganizationIds.length === 0) return [];

      const legInput: RetrieveInput = {
        ...input,
        topK: candidatesPerLeg,
      };
      // Run legs in parallel. Vector leg can fail (missing API key, Voyage
      // down) — fall back to FTS-only rather than 500ing the whole search.
      const [ftsRows, vecRows] = await Promise.all([
        fts.retrieve(legInput),
        vec.retrieve(legInput).catch(() => [] as SearchHit[]),
      ]);

      const fused = reciprocalRankFusion(ftsRows, vecRows, rrfK);
      if (fused.length === 0) return [];

      if (options.skipRerank) {
        return fused.slice(0, options.topK);
      }

      try {
        const ranked = await rerank(
          input.query,
          fused.map((c) => c.content),
          options.topK,
        );
        return ranked.map((r) => {
          const base = fused[r.index]!;
          return { ...base, score: r.score };
        });
      } catch {
        return fused.slice(0, options.topK);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function reciprocalRankFusion(
  a: SearchHit[],
  b: SearchHit[],
  k: number,
): SearchHit[] {
  const scoreById = new Map<string, { score: number; hit: SearchHit }>();
  const add = (rank: number, hit: SearchHit) => {
    const rrf = 1 / (k + rank);
    const prev = scoreById.get(hit.id);
    if (prev) prev.score += rrf;
    else scoreById.set(hit.id, { score: rrf, hit });
  };
  a.forEach((h, i) => add(i + 1, h));
  b.forEach((h, i) => add(i + 1, h));
  return [...scoreById.values()]
    .sort((x, y) => y.score - x.score)
    .map(({ score, hit }) => ({ ...hit, score }));
}

interface RawRow {
  id: string;
  source_type: SearchSourceType;
  source_id: string;
  document_id: string | null;
  content_pack_version_id: string;
  owner_organization_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number | string;
}

function mapRow(r: RawRow): SearchHit {
  return {
    id: r.id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    documentId: r.document_id,
    contentPackVersionId: r.content_pack_version_id,
    ownerOrganizationId: r.owner_organization_id,
    title: r.title,
    content: r.content,
    metadata: r.metadata ?? {},
    score: Number(r.score),
  };
}
