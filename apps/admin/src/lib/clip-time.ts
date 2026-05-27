// Time helpers used by every per-step clip editor — the AI-walkthrough
// draft reviewer at /procedure-drafts/[runId] and the published-step
// clip-range editor inside the procedure CMS share the same mm:ss
// input semantics. Centralized here so a tweak to parsing rules (e.g.,
// accepting "1m30s") lands in one spot.

/** Format a millisecond duration as a zero-padded mm:ss string. */
export function formatMmSs(ms: number): string {
  const safe = Math.max(0, ms | 0);
  const totalSec = Math.floor(safe / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

/**
 * Parse a user-typed mm:ss (or bare seconds) into milliseconds. Returns
 * null when the input is incomplete or unparseable so the caller can
 * leave the prior value alone while the author is still typing.
 */
export function parseMmSs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (match) {
    const mm = Number(match[1]);
    const ss = Number(match[2]);
    if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss >= 60) return null;
    return (mm * 60 + ss) * 1000;
  }
  // Allow plain seconds entry for fast scrubbing.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  return null;
}

/** Display a clip duration in the most human form for the size. */
export function formatClipDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${safe}ms`;
  return `${(safe / 1000).toFixed(1)}s`;
}
