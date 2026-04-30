// Locate a stored anchor (excerpt + surrounding context) inside a freshly-
// rendered page-level text string. Used at PWA render time and inside the
// admin editor when refreshing highlight overlays after a page re-render.
//
// Strategy mirrors the re-validation ladder in @platform/ai/sections but
// runs synchronously against a single page's text (no embedding fallback —
// PWA never sees flagged sections, so an unfindable anchor here is a bug
// signal, not a normal case):
//
//   1. Exact match of `before + excerpt + after`.
//   2. Exact match of `excerpt` alone.
//   3. Whitespace/case-normalized exact match of `excerpt`.
//
// Returns the character offsets within the supplied page text that the
// caller should highlight. Returns null when no match — callers should
// fall back to rendering without a highlight (the section title still
// shows; the page itself still renders).

export interface LocateOptions {
  pageText: string;
  excerpt: string;
  contextBefore?: string | null;
  contextAfter?: string | null;
}

export interface LocateResult {
  charStart: number;
  charEnd: number;
  /** Which stage of the ladder produced this match — surfaced for diagnostics. */
  stage: 'context' | 'excerpt' | 'normalized';
}

export function locateExcerptInPage(opts: LocateOptions): LocateResult | null {
  const { pageText, excerpt } = opts;
  if (!pageText || !excerpt) return null;

  // Stage 1: full context+excerpt+context.
  const before = opts.contextBefore ?? '';
  const after = opts.contextAfter ?? '';
  if (before || after) {
    const needle = before + excerpt + after;
    const idx = pageText.indexOf(needle);
    if (idx >= 0) {
      const start = idx + before.length;
      return { charStart: start, charEnd: start + excerpt.length, stage: 'context' };
    }
  }

  // Stage 2: excerpt alone (exact).
  const exactIdx = pageText.indexOf(excerpt);
  if (exactIdx >= 0) {
    return {
      charStart: exactIdx,
      charEnd: exactIdx + excerpt.length,
      stage: 'excerpt',
    };
  }

  // Stage 3: normalized excerpt against normalized page text. We then map
  // the normalized hit back to original page-text offsets.
  const norm = buildNormalizedMap(pageText);
  const normExcerpt = normalizeForLocate(excerpt);
  if (!normExcerpt) return null;

  const normIdx = norm.normalized.indexOf(normExcerpt);
  if (normIdx < 0) return null;
  const start = norm.indexMap[normIdx];
  const end = norm.indexMap[normIdx + normExcerpt.length];
  if (start == null || end == null) return null;
  return { charStart: start, charEnd: end, stage: 'normalized' };
}

interface NormalizedMap {
  normalized: string;
  /** indexMap[i] = original index of normalized char i (or end position). */
  indexMap: number[];
}

function buildNormalizedMap(text: string): NormalizedMap {
  const out: string[] = [];
  const idx: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace && out.length > 0) {
        out.push(' ');
        idx.push(i);
      }
      inWhitespace = true;
    } else {
      out.push(ch.toLowerCase());
      idx.push(i);
      inWhitespace = false;
    }
  }
  // Trim trailing space we may have added.
  if (out[out.length - 1] === ' ') {
    out.pop();
    idx.pop();
  }
  // Final sentinel maps end-of-normalized to end-of-original.
  idx.push(text.length);
  return { normalized: out.join(''), indexMap: idx };
}

function normalizeForLocate(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Highlight rect computation (when we have run-level positions from the PDF
// text layer, we can convert a character span into one or more rects).
// ---------------------------------------------------------------------------

export interface RunPosition {
  charStart: number;
  charEnd: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Given a character span and the page's text-layer runs, produce one rect
 * per run that overlaps the span. Each rect is clipped to the portion of the
 * run that falls inside [start, end). Width is approximated by linear
 * interpolation across the run's character extent.
 */
export function rectsForSpan(
  start: number,
  end: number,
  runs: ReadonlyArray<RunPosition>,
): HighlightRect[] {
  const rects: HighlightRect[] = [];
  for (const run of runs) {
    if (run.charEnd <= start) continue;
    if (run.charStart >= end) break;
    const overlapStart = Math.max(start, run.charStart);
    const overlapEnd = Math.min(end, run.charEnd);
    const runLen = run.charEnd - run.charStart;
    if (runLen <= 0) continue;
    const startFraction = (overlapStart - run.charStart) / runLen;
    const endFraction = (overlapEnd - run.charStart) / runLen;
    rects.push({
      x: run.x + run.width * startFraction,
      y: run.y,
      width: run.width * (endFraction - startFraction),
      height: run.height,
    });
  }
  return rects;
}
