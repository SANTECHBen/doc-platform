// Document section re-validation.
//
// Sections are admin-authored annotations on documents. When a document is
// re-extracted (e.g., the OEM uploads a revised manual), the stored anchors
// might no longer point at the right content. Rather than blindly preserve
// stale data or wipe everything on re-upload, this module runs a
// content-similarity check per section and either:
//
//   - accepts the section silently (anchors still good — most common),
//   - accepts with auto-migrated anchors (content shifted slightly but we
//     can re-locate it confidently),
//   - flags for manual admin review (content drifted too far for an
//     automated rebound — admin sees a banner and re-picks).
//
// Three-stage ladder for text_range (the hardest case):
//   1. Exact match of the original excerpt + surrounding context window.
//   2. Windowed normalized match (whitespace/case-insensitive Levenshtein).
//   3. Embedding fallback (Voyage-3 cosine similarity vs. new chunks).
//
// Page_range and time_range have simpler validation paths (count / duration
// checks plus an optional similarity sanity check).
//
// This module is pure and deterministic given inputs — tests can mock the
// embed callback to avoid Voyage round-trips.

import type { DocumentSectionKind } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Subset of a document_sections row that re-validation reads. We accept a
 * plain object so the algorithm has no DB dependency.
 */
export interface RevalidatableSection {
  id: string;
  kind: DocumentSectionKind;
  pageStart: number | null;
  pageEnd: number | null;
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;
}

/**
 * Outcome of revalidating one section.
 *   - `accepted` — anchors still valid (or were rebound by an auto-migration
 *     stage). Caller should clear `needs_revalidation` and update
 *     `source_extraction_at`. `updates` may carry rebound anchor values.
 *   - `flagged` — anchors broken or ambiguous; caller should set
 *     `needs_revalidation = true` with the given reason. PWA omits flagged
 *     sections; admin sees them with a "review" affordance.
 */
export type RevalidationOutcome =
  | {
      status: 'accepted';
      reason: string | null;
      updates?: {
        anchorExcerpt?: string;
        anchorContextBefore?: string | null;
        anchorContextAfter?: string | null;
        textPageHint?: number | null;
      };
    }
  | { status: 'flagged'; reason: string };

/** Embedding callback used by stage 3. Caller wires this to Voyage. */
export type EmbedSimilarityFn = (input: {
  excerpt: string;
  /** Candidates to compare against, in document order. */
  candidates: Array<{ chunkId: string | null; text: string }>;
}) => Promise<{
  bestIndex: number;
  bestScore: number; // 0..1 cosine similarity
}>;

export interface RevalidateInput {
  section: RevalidatableSection;
  /** Old extracted text — what the section anchors were captured against.
   *  Null when this is the section's first validation (newly created). */
  oldExtractedText: string | null;
  /** Current extracted text — what we're re-validating against. */
  newExtractedText: string | null;
  /** Video duration in seconds — for time_range only. */
  newDurationSeconds: number | null;
  /** Optional embed callback for stage 3 of text_range. Without it, stage 3
   *  is skipped and a stage-2 miss results in a flag. */
  embedSimilarity?: EmbedSimilarityFn;
  /** Candidate chunks for embedding fallback. Same document, current
   *  content. (chunkId is opaque to the algorithm; passed through for
   *  caller's logging if needed.) */
  candidateChunks?: Array<{ chunkId: string | null; text: string }>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const PAGE_JACCARD_ACCEPT = 0.7; // combined unigram+bigram overlap threshold for page_range silent accept
const NORMALIZED_LEVENSHTEIN_ACCEPT = 0.1; // ≤ 0.1 = accept on stage 2
const EMBEDDING_ACCEPT = 0.92; // ≥ 0.92 cosine = accept on stage 3
const SLIDING_LENGTH_TOLERANCE = 0.1; // ±10% length variation in stage 2

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function revalidateSection(input: RevalidateInput): Promise<RevalidationOutcome> {
  switch (input.section.kind) {
    case 'page_range':
      return revalidatePageRange(input);
    case 'text_range':
      return revalidateTextRange(input);
    case 'time_range':
      return revalidateTimeRange(input);
  }
}

// ---------------------------------------------------------------------------
// page_range
// ---------------------------------------------------------------------------
//
// Algorithm:
//   1. If the new total page count is < pageEnd, the section is broken.
//   2. If the page count matches the old, compare per-page word-bigram
//      Jaccard between old and new text on the section's pages. ≥ 0.85 →
//      accept silently.
//   3. Otherwise flag with the similarity score.

function revalidatePageRange(input: RevalidateInput): RevalidationOutcome {
  const { section, oldExtractedText, newExtractedText } = input;
  if (section.pageStart == null || section.pageEnd == null) {
    return { status: 'flagged', reason: 'page_range section has null page bounds' };
  }
  if (newExtractedText == null) {
    // Document hasn't been extracted (e.g. extractionStatus !== 'ready'). We
    // can't validate; leave the flag in whatever state the caller had.
    // Return accepted with no change so we don't regress the section.
    return { status: 'accepted', reason: 'document has no extracted text yet' };
  }

  const newPages = parsePageMarkers(newExtractedText);
  const newPageCount = newPages.length;

  // No page markers in new text — fall through to a more lenient check.
  // (If the new doc lost its page markers, we can't validate page-by-page;
  // the section is suspect.)
  if (newPageCount === 0) {
    return {
      status: 'flagged',
      reason: 'new extraction has no page markers; page_range cannot be validated',
    };
  }

  if (section.pageEnd > newPageCount) {
    return {
      status: 'flagged',
      reason: `page count shrank: section ends at page ${section.pageEnd}, new doc has ${newPageCount}`,
    };
  }

  // If we don't have old text to compare against, accept on count check alone.
  if (!oldExtractedText) {
    return { status: 'accepted', reason: null };
  }

  const oldPages = parsePageMarkers(oldExtractedText);
  if (oldPages.length === 0) {
    // Old text didn't have markers — can't compare per-page; accept on
    // count check alone.
    return { status: 'accepted', reason: null };
  }

  // Compare each page in the section's range. If any page's Jaccard < threshold,
  // flag the section.
  let totalSim = 0;
  let pagesCompared = 0;
  for (let p = section.pageStart; p <= section.pageEnd; p++) {
    const oldText = sliceTextForPage(oldExtractedText, oldPages, p);
    const newText = sliceTextForPage(newExtractedText, newPages, p);
    if (oldText == null || newText == null) continue;
    const sim = wordBigramJaccard(oldText, newText);
    totalSim += sim;
    pagesCompared += 1;
  }
  if (pagesCompared === 0) {
    return { status: 'accepted', reason: 'no comparable pages' };
  }
  const avgSim = totalSim / pagesCompared;
  if (avgSim >= PAGE_JACCARD_ACCEPT) {
    return { status: 'accepted', reason: null };
  }
  return {
    status: 'flagged',
    reason: `page content drifted (${(avgSim * 100).toFixed(0)}% bigram overlap, threshold ${(PAGE_JACCARD_ACCEPT * 100).toFixed(0)}%)`,
  };
}

// ---------------------------------------------------------------------------
// text_range — three-stage ladder
// ---------------------------------------------------------------------------

async function revalidateTextRange(input: RevalidateInput): Promise<RevalidationOutcome> {
  const { section, newExtractedText, embedSimilarity, candidateChunks } = input;
  if (!section.anchorExcerpt) {
    return { status: 'flagged', reason: 'text_range section has no anchor_excerpt' };
  }
  if (!newExtractedText) {
    return { status: 'accepted', reason: 'document has no extracted text yet' };
  }

  const excerpt = section.anchorExcerpt;
  const before = section.anchorContextBefore ?? '';
  const after = section.anchorContextAfter ?? '';

  // Stage 1: exact match of context+excerpt+context as a single window.
  const stage1 = exactMatch(newExtractedText, excerpt, before, after);
  if (stage1.kind === 'unique') {
    return { status: 'accepted', reason: null };
  }
  if (stage1.kind === 'multiple') {
    // If we have a page hint, see if it disambiguates.
    if (section.textPageHint != null) {
      const pages = parsePageMarkers(newExtractedText);
      const target = pages.find((p) => p.pageNumber === section.textPageHint);
      if (target) {
        const inPage = stage1.positions.filter(
          (pos) => pos >= target.charStart && pos < target.charEnd,
        );
        if (inPage.length === 1) {
          return { status: 'accepted', reason: 'disambiguated by text_page_hint' };
        }
      }
    }
    // Multiple matches and no disambiguation — flag rather than guessing.
    return {
      status: 'flagged',
      reason: `excerpt appears ${stage1.positions.length} times in new extraction; cannot disambiguate`,
    };
  }

  // Stage 2: windowed normalized match.
  const stage2 = windowedNormalizedMatch(newExtractedText, excerpt);
  if (stage2.kind === 'unique') {
    // Update the anchor context windows from the new neighborhood.
    const updates = neighborhoodUpdates(newExtractedText, stage2.position, excerpt.length);
    return {
      status: 'accepted',
      reason: 'auto-rebound by normalized match',
      updates,
    };
  }

  // Stage 3: embedding fallback.
  if (embedSimilarity && candidateChunks && candidateChunks.length > 0) {
    const result = await embedSimilarity({ excerpt, candidates: candidateChunks });
    if (result.bestScore >= EMBEDDING_ACCEPT) {
      const winner = candidateChunks[result.bestIndex];
      if (winner) {
        // Re-anchor: use the winning chunk's text as the new excerpt
        // anchor (it's the closest semantic match in the new doc).
        return {
          status: 'accepted',
          reason: `auto-rebound by embedding similarity (${(result.bestScore * 100).toFixed(1)}%)`,
          updates: {
            anchorExcerpt: winner.text,
            anchorContextBefore: null,
            anchorContextAfter: null,
          },
        };
      }
    }
    return {
      status: 'flagged',
      reason: `manual review required (best embedding similarity ${(result.bestScore * 100).toFixed(1)}%)`,
    };
  }

  return {
    status: 'flagged',
    reason: 'manual review required (no embedding fallback available)',
  };
}

// ---------------------------------------------------------------------------
// time_range
// ---------------------------------------------------------------------------

function revalidateTimeRange(input: RevalidateInput): RevalidationOutcome {
  const { section, newDurationSeconds } = input;
  if (section.timeStartSeconds == null || section.timeEndSeconds == null) {
    return { status: 'flagged', reason: 'time_range section has null time bounds' };
  }
  if (newDurationSeconds == null) {
    // Duration unknown — accept (videos rarely re-extract; the duration is
    // only known at upload time).
    return { status: 'accepted', reason: 'duration unknown; accepted by default' };
  }
  if (section.timeEndSeconds > newDurationSeconds) {
    return {
      status: 'flagged',
      reason: `video shortened: section ends at ${section.timeEndSeconds.toFixed(1)}s, new duration is ${newDurationSeconds.toFixed(1)}s`,
    };
  }
  return { status: 'accepted', reason: null };
}

// ---------------------------------------------------------------------------
// Helpers — exported so tests + tooling can reuse
// ---------------------------------------------------------------------------

/** Match `<!-- page:N -->` markers and return per-page char ranges. */
export function parsePageMarkers(
  text: string,
): Array<{ pageNumber: number; charStart: number; charEnd: number }> {
  const pages: Array<{ pageNumber: number; charStart: number; charEnd: number }> = [];
  const re = /<!--\s*page:(\d+)\s*-->/g;
  const matches: Array<{ pageNumber: number; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ pageNumber: Number(m[1]), start: m.index });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.start;
    const end = i + 1 < matches.length ? matches[i + 1]!.start : text.length;
    pages.push({ pageNumber: matches[i]!.pageNumber, charStart: start, charEnd: end });
  }
  return pages;
}

function sliceTextForPage(
  text: string,
  pages: Array<{ pageNumber: number; charStart: number; charEnd: number }>,
  pageNumber: number,
): string | null {
  const p = pages.find((x) => x.pageNumber === pageNumber);
  if (!p) return null;
  return text.slice(p.charStart, p.charEnd);
}

/** Word n-gram Jaccard similarity (0..1) over the union of unigrams and
 *  bigrams. Combining the two makes the metric robust to small edits on
 *  short pages (where pure-bigram drops sharply for a single word add)
 *  while still penalizing whole-paragraph rewrites. Page markers are
 *  stripped before tokenizing. */
export function wordBigramJaccard(a: string, b: string): number {
  const setA = wordNgrams(a);
  const setB = wordNgrams(b);
  if (setA.size === 0 && setB.size === 0) return 1; // identical (empty)
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const ngram of setA) {
    if (setB.has(ngram)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function wordNgrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/<!--[\s\S]*?-->/g, ' ') // strip page markers
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    out.add('1:' + words[i]); // unigram (prefixed to avoid collision with bigrams)
    if (i + 1 < words.length) {
      out.add('2:' + words[i] + ' ' + words[i + 1]);
    }
  }
  return out;
}

interface ExactMatchResult {
  kind: 'unique' | 'multiple' | 'none';
  positions: number[];
}

/** Find all occurrences of `before+excerpt+after` (exact) in haystack. */
function exactMatch(
  haystack: string,
  excerpt: string,
  before: string,
  after: string,
): ExactMatchResult {
  const needle = before + excerpt + after;
  if (needle.length === 0) return { kind: 'none', positions: [] };
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx + before.length); // position of excerpt start
    from = idx + 1;
    if (positions.length > 5) break; // bail if pathologically common
  }
  if (positions.length === 0) {
    // Try just the excerpt without context — looser but useful when context
    // shifted but the excerpt itself is intact.
    let from2 = 0;
    while (true) {
      const idx = haystack.indexOf(excerpt, from2);
      if (idx === -1) break;
      positions.push(idx);
      from2 = idx + 1;
      if (positions.length > 5) break;
    }
  }
  if (positions.length === 0) return { kind: 'none', positions: [] };
  if (positions.length === 1) return { kind: 'unique', positions };
  return { kind: 'multiple', positions };
}

interface WindowedMatchResult {
  kind: 'unique' | 'none';
  position: number;
}

/** Stage 2: slide a window of length len(excerpt)±10% across haystack and
 *  find the unique window with the smallest normalized Levenshtein. Both
 *  sides are normalized (lowercased, whitespace-collapsed). */
function windowedNormalizedMatch(haystack: string, excerpt: string): WindowedMatchResult {
  const normalizedExcerpt = normalize(excerpt);
  const normalizedHaystack = normalize(haystack);
  if (normalizedExcerpt.length === 0) return { kind: 'none', position: -1 };

  const windowMin = Math.max(1, Math.floor(normalizedExcerpt.length * (1 - SLIDING_LENGTH_TOLERANCE)));
  const windowMax = Math.ceil(normalizedExcerpt.length * (1 + SLIDING_LENGTH_TOLERANCE));
  const maxDistance = Math.ceil(normalizedExcerpt.length * NORMALIZED_LEVENSHTEIN_ACCEPT);

  // Step is bounded by the Levenshtein threshold so we never skip past a
  // window that would have matched. Larger excerpts get larger steps to keep
  // the cost roughly linear in haystack size.
  const step = Math.max(1, Math.floor(maxDistance / 2));
  let best = { ratio: Infinity, position: -1 };
  for (let i = 0; i + windowMin <= normalizedHaystack.length; i += step) {
    for (let len = windowMin; len <= windowMax; len += step) {
      if (i + len > normalizedHaystack.length) break;
      const window = normalizedHaystack.slice(i, i + len);
      const distance = levenshteinUpTo(normalizedExcerpt, window, maxDistance);
      if (distance == null) continue; // exceeded threshold
      const ratio = distance / normalizedExcerpt.length;
      if (ratio < best.ratio) {
        best = { ratio, position: i };
      }
    }
  }

  if (best.ratio <= NORMALIZED_LEVENSHTEIN_ACCEPT) {
    // Map normalized position back to original haystack position. The
    // normalize() function only collapses whitespace and lowercases, so we
    // can use a position-mapping function for accuracy.
    const originalPos = mapNormalizedPositionToOriginal(haystack, best.position);
    return { kind: 'unique', position: originalPos };
  }
  return { kind: 'none', position: -1 };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Position mapping from normalized index back to original index. Walks both
 *  strings, advancing the original cursor past skipped/collapsed whitespace
 *  to find where character `n` of the normalized form corresponds to in the
 *  original. */
function mapNormalizedPositionToOriginal(original: string, normalizedPos: number): number {
  let originalIdx = 0;
  let normalizedIdx = 0;
  let inWhitespace = false;
  while (originalIdx < original.length && normalizedIdx < normalizedPos) {
    const ch = original[originalIdx]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace && originalIdx > 0) {
        // First whitespace char — counts as one space in normalized.
        normalizedIdx += 1;
      }
      inWhitespace = true;
    } else {
      inWhitespace = false;
      normalizedIdx += 1;
    }
    originalIdx += 1;
  }
  // Skip any leading-whitespace mismatch.
  while (originalIdx < original.length && /\s/.test(original[originalIdx]!)) {
    originalIdx += 1;
  }
  return originalIdx;
}

/** Levenshtein with early-exit when the running minimum exceeds maxDistance.
 *  Returns null when the threshold is exceeded (caller should treat as
 *  "no good match"). Standard DP, single-row optimization. */
function levenshteinUpTo(a: string, b: string, maxDistance: number): number | null {
  if (Math.abs(a.length - b.length) > maxDistance) return null;
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const prev: number[] = new Array(n + 1);
  const curr: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > maxDistance) return null;
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return prev[n] ?? null;
}

/** When stage 2 succeeds, capture fresh ~200-char context windows around the
 *  new position so the next re-validation has updated anchors. */
function neighborhoodUpdates(
  newText: string,
  excerptStart: number,
  excerptLen: number,
): {
  anchorContextBefore: string;
  anchorContextAfter: string;
} {
  const CONTEXT = 200;
  const before = newText.slice(Math.max(0, excerptStart - CONTEXT), excerptStart);
  const after = newText.slice(excerptStart + excerptLen, excerptStart + excerptLen + CONTEXT);
  return { anchorContextBefore: before, anchorContextAfter: after };
}
