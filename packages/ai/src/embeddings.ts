// Voyage AI client — embeddings and reranking via REST (no official Node SDK).
//
// Voyage pairs well with Claude for technical / engineering content and is
// Anthropic's recommended partner for retrieval augmented generation. We use:
//   - voyage-3      (1024 dims) — the default document / query embedder.
//   - rerank-2-lite — final-stage reranker over the hybrid candidate pool.
//
// All requests go over HTTPS with the API key as a bearer token. The key
// lives in the VOYAGE_API_KEY env var; callers fail loudly (not silently) if
// it's missing so we don't ship a "retrieval quietly degraded" bug.

const VOYAGE_API = 'https://api.voyageai.com/v1';

// voyage-3 is 1024 dims — must match the `vector(1024)` column in document_chunks.
// If you ever move to voyage-3-large (1024) or voyage-code-3 (1024) the dim is
// the same; voyage-3-xl is 2048 and would require a schema change.
export const EMBEDDING_MODEL = 'voyage-3';
export const EMBEDDING_DIMS = 1024;
export const RERANK_MODEL = 'rerank-2-lite';

// Voyage's batch ceiling for voyage-3 is 128 inputs per request. We chunk
// larger jobs into parallel batches rather than hitting this limit.
const EMBED_BATCH_SIZE = 128;

export type VoyageInputType = 'query' | 'document';

interface VoyageEmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

interface VoyageRerankResponse {
  data: Array<{
    index: number;
    relevance_score: number;
    document?: string;
  }>;
  model: string;
  usage: { total_tokens: number };
}

function requireApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error(
      'VOYAGE_API_KEY is not set. Retrieval needs a Voyage key; set the Fly secret and redeploy.',
    );
  }
  return key;
}

async function voyageFetch<T>(path: string, body: unknown): Promise<T> {
  // Retry 429s with exponential backoff. Free-tier Voyage allows only 3 RPM
  // for embeddings — without backoff the parallel-batch path inside embedBatch
  // hammers the limit and fails. With backoff we get through on free tier
  // for moderate-size docs (slowly), and paid tiers don't notice.
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(`${VOYAGE_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${requireApiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as T;

    if (res.status === 429 && attempt < maxAttempts) {
      // 1s, 2s, 4s, 8s — tunable. Also honor Retry-After when Voyage sends it.
      const retryAfter = Number(res.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * Math.pow(2, attempt - 1);
      // Drain body so the connection releases.
      await res.text().catch(() => '');
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const text = await res.text().catch(() => '(no body)');
    throw new Error(`Voyage ${path} ${res.status}: ${text}`);
  }
  throw new Error(`Voyage ${path}: exhausted retries`);
}

/**
 * Embed a batch of texts. `input_type` is important for retrieval quality —
 * queries and documents live in slightly different embedding subspaces in
 * voyage-3, so tagging them correctly at embedding time boosts recall.
 *
 * Input order is preserved in the output array.
 */
export async function embedBatch(
  inputs: string[],
  inputType: VoyageInputType,
): Promise<number[][]> {
  if (inputs.length === 0) return [];

  // Split oversized batches. We send sequentially rather than in parallel
  // because Voyage's free-tier rate limit is 3 RPM — parallel batches
  // immediately trip 429. The retry-with-backoff inside voyageFetch handles
  // transient limits; sequential dispatch keeps us under the limit on the
  // happy path. Throughput cost is negligible for typical docs (1–3 batches).
  const batches: string[][] = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
    batches.push(inputs.slice(i, i + EMBED_BATCH_SIZE));
  }
  const results: VoyageEmbeddingsResponse[] = [];
  for (const batch of batches) {
    const r = await voyageFetch<VoyageEmbeddingsResponse>('/embeddings', {
      input: batch,
      model: EMBEDDING_MODEL,
      input_type: inputType,
    });
    results.push(r);
  }

  // Flatten, honoring each batch's internal `index` ordering.
  const out: number[][] = [];
  for (const batch of results) {
    const sorted = [...batch.data].sort((a, b) => a.index - b.index);
    for (const row of sorted) out.push(row.embedding);
  }
  return out;
}

/**
 * Embed a single document or query. Convenience wrapper around embedBatch.
 */
export async function embed(input: string, inputType: VoyageInputType): Promise<number[]> {
  const [vec] = await embedBatch([input], inputType);
  if (!vec) throw new Error('Voyage returned no embedding');
  return vec;
}

/**
 * Rerank a candidate pool against a query. This is the big quality lever in
 * RAG — the initial hybrid retrieval (FTS + vectors) casts a wide net, and
 * the reranker picks the ones that actually answer the question.
 *
 * Returns indices (into the original `documents` array) in rank order, with
 * relevance scores. We don't need the rewritten text back, so ask Voyage to
 * skip it (`return_documents: false`) — less bandwidth, fewer tokens billed.
 */
export async function rerank(
  query: string,
  documents: string[],
  topK: number,
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];
  // Voyage charges per input token; cap documents to what we'll actually use.
  // topK * 6 gives the reranker a healthy pool without burning budget.
  const pool = documents.slice(0, Math.min(documents.length, Math.max(topK * 6, topK)));

  const res = await voyageFetch<VoyageRerankResponse>('/rerank', {
    query,
    documents: pool,
    model: RERANK_MODEL,
    top_k: topK,
    return_documents: false,
  });

  return res.data.map((r) => ({ index: r.index, score: r.relevance_score }));
}
