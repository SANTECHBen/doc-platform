'use client';

// ClipTrimSlider — drag-to-trim handles for an AI-walkthrough step clip.
//
// Replaces the mm:ss number inputs in the draft reviewer and the
// published-step trim panel with a horizontal timeline:
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │            ◀━━━━ clip region ━━━━▶                          │
//   └─────────────────────────────────────────────────────────────┘
//      00:00         start          end                    duration
//
// Drag the left handle to change clipStart; drag the right handle to
// change clipEnd; the highlighted region between is read-only (a future
// pass could allow grabbing the bar to slide the whole window).
//
// Constraints honored on every drag tick:
//   * 0 <= startMs <= endMs - minSpanMs
//   * startMs + minSpanMs <= endMs <= timelineEndMs (and >= startMs +
//     minSpanMs, <= startMs + maxSpanMs)
//   * Values snap to 100ms — Mux's segment_size=2 already coarsens edge
//     accuracy and the LLM/snap pass usually pick cue boundaries that
//     round cleanly; 100ms granularity is plenty for a human-perceptible
//     trim and keeps integer math honest.
//
// Pointer events handle mouse + touch + stylus. We capture the pointer
// on handle pointerdown so a drag that leaves the slider still updates
// (handle "sticks" to the cursor), then release on pointerup.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatMmSs, formatClipDuration } from '@/lib/clip-time';

interface Props {
  /** Current trim start in ms (relative to the source video). */
  startMs: number;
  /** Current trim end in ms. */
  endMs: number;
  /** Beginning of the visible timeline (usually 0). */
  timelineStartMs?: number;
  /** End of the visible timeline. Set this to the source video duration
   *  when known so the handles can drag the full range; falls back to a
   *  context window around [startMs..endMs] when not available. */
  timelineEndMs: number;
  /** Minimum legal clip span (ms). Default 200 — lets a hand-trim dip
   *  into "brief click" territory; the drafter's 2s LLM-target floor
   *  applies only to model emissions. */
  minSpanMs?: number;
  /** Maximum legal clip span (ms). Default 20000. */
  maxSpanMs?: number;
  disabled?: boolean;
  /** Optional live playhead position in ms (relative to the source).
   *  When the parent's clip-preview player is playing, threading its
   *  currentTime through here paints a moving cursor on the timeline
   *  so the reviewer can see where in the source the playback head is.
   *  Pass null/undefined to hide the cursor. */
  playheadMs?: number | null;
  onChange: (next: { startMs: number; endMs: number }) => void;
  /** Optional commit callback — fires once on pointerup, useful for
   *  triggering a debounced server preview that shouldn't run on every
   *  drag tick. The continuous tick comes through onChange. */
  onCommit?: (next: { startMs: number; endMs: number }) => void;
}

const SNAP_MS = 100;

function snap(ms: number): number {
  return Math.round(ms / SNAP_MS) * SNAP_MS;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function ClipTrimSlider({
  startMs,
  endMs,
  timelineStartMs = 0,
  timelineEndMs,
  minSpanMs = 200,
  maxSpanMs = 20_000,
  disabled = false,
  playheadMs,
  onChange,
  onCommit,
}: Props): React.ReactElement {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // `dragging` discriminates which handle is active during a drag —
  // also drives the visual "active" styling on the handle.
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  // Cached track geometry, refreshed on pointerdown. Reading
  // getBoundingClientRect on every pointermove is fine but caching once
  // per drag avoids reflow churn on long drags.
  const geomRef = useRef<{ left: number; width: number } | null>(null);
  // Mirror the latest controlled bounds into refs so onCommit handlers
  // always read the freshest values, not a closure captured one
  // render ago. Critical for the pointerup path on fast drags and for
  // keyboard nudges that commit synchronously inside the same render.
  const startMsRef = useRef(startMs);
  const endMsRef = useRef(endMs);
  useEffect(() => {
    startMsRef.current = startMs;
    endMsRef.current = endMs;
  }, [startMs, endMs]);

  const timelineSpan = Math.max(1, timelineEndMs - timelineStartMs);

  // Pixel positions of each handle, expressed as percentages of the
  // track width. Computed on each render from current props so the
  // slider visually follows external changes (e.g., the parent typed
  // into a hidden mm:ss input — currently unused, but defensive).
  const startPct = useMemo(
    () => clamp(((startMs - timelineStartMs) / timelineSpan) * 100, 0, 100),
    [startMs, timelineStartMs, timelineSpan],
  );
  const endPct = useMemo(
    () => clamp(((endMs - timelineStartMs) / timelineSpan) * 100, 0, 100),
    [endMs, timelineStartMs, timelineSpan],
  );

  const span = endMs - startMs;

  // Convert a pointer X (clientX) into a snapped ms on the timeline,
  // clamped to the slider track. Pulled from the cached geometry so the
  // result stays correct even if the page scrolls during a drag.
  const xToMs = useCallback((clientX: number): number => {
    const g = geomRef.current;
    if (!g || g.width <= 0) return timelineStartMs;
    const ratio = clamp((clientX - g.left) / g.width, 0, 1);
    return snap(timelineStartMs + ratio * timelineSpan);
  }, [timelineStartMs, timelineSpan]);

  const updateStart = useCallback(
    (ms: number) => {
      // start must leave room for min span and respect max span. Read
      // from refs so a drag tick or keyboard nudge that fires inside
      // the same render still sees the freshest end value.
      const minStart = timelineStartMs;
      const maxStart = Math.max(minStart, endMsRef.current - minSpanMs);
      const minStartForMax = endMsRef.current - maxSpanMs;
      const next = clamp(ms, Math.max(minStart, minStartForMax), maxStart);
      if (next !== startMsRef.current) {
        startMsRef.current = next;
        onChange({ startMs: next, endMs: endMsRef.current });
      }
    },
    [minSpanMs, maxSpanMs, onChange, timelineStartMs],
  );

  const updateEnd = useCallback(
    (ms: number) => {
      const minEnd = startMsRef.current + minSpanMs;
      const maxEnd = Math.min(timelineEndMs, startMsRef.current + maxSpanMs);
      const next = clamp(ms, minEnd, maxEnd);
      if (next !== endMsRef.current) {
        endMsRef.current = next;
        onChange({ startMs: startMsRef.current, endMs: next });
      }
    },
    [minSpanMs, maxSpanMs, onChange, timelineEndMs],
  );

  const onPointerDown = useCallback(
    (handle: 'start' | 'end') => (e: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      e.preventDefault();
      // setPointerCapture lets us keep receiving pointermove/pointerup
      // even when the cursor wanders off the handle's hit box.
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect) geomRef.current = { left: rect.left, width: rect.width };
      setDragging(handle);
    },
    [disabled],
  );

  // Document-level move/up listeners installed only while dragging.
  // Using addEventListener (rather than React's bubbled handlers) means
  // a pointer leaving the slider element still drives updates — pointer
  // capture on the handle would suffice on its own for that, but the
  // doc-level listeners also catch the case where the browser silently
  // drops capture (some Linux WMs do this on alt-tab).
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const ms = xToMs(e.clientX);
      if (dragging === 'start') updateStart(ms);
      else updateEnd(ms);
    }
    function onUp() {
      setDragging(null);
      geomRef.current = null;
      // Read from refs — the closure-captured startMs/endMs might be
      // one tick behind on a fast drag-then-release sequence.
      onCommit?.({ startMs: startMsRef.current, endMs: endMsRef.current });
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
    // Bounds removed from deps — onUp reads refs (always current) and
    // onMove uses xToMs + the stable update helpers. Re-binding on every
    // drag tick would churn add/removeEventListener uselessly.
  }, [dragging, xToMs, updateStart, updateEnd, onCommit]);

  // Keyboard nudges — left/right arrow adjusts the focused handle by
  // SNAP_MS, shift+arrow by 1s. Matches typical timeline editor a11y
  // affordances (Premiere, DaVinci, etc.). updateStart/updateEnd write
  // refs synchronously so onCommit fires with the post-nudge value.
  const onKey = useCallback(
    (handle: 'start' | 'end') =>
      (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return;
        const step =
          e.key === 'ArrowLeft' || e.key === 'ArrowRight'
            ? e.shiftKey
              ? 1_000
              : SNAP_MS
            : 0;
        if (step === 0) return;
        e.preventDefault();
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        if (handle === 'start') {
          updateStart(startMsRef.current + direction * step);
        } else {
          updateEnd(endMsRef.current + direction * step);
        }
        onCommit?.({ startMs: startMsRef.current, endMs: endMsRef.current });
      },
    [disabled, updateStart, updateEnd, onCommit],
  );

  // Major-tick marker positions. We draw ticks every ~10% of the
  // timeline OR every 5 seconds, whichever is sparser, so a 5-min source
  // doesn't render dozens of overlapping markers.
  const tickEveryMs = Math.max(5_000, Math.floor(timelineSpan / 10));
  const ticks: number[] = [];
  for (let t = timelineStartMs; t <= timelineEndMs; t += tickEveryMs) {
    ticks.push(t);
  }

  return (
    <div className="select-none">
      {/* Top labels — show the current start/end and the resulting
          clip duration. Read-only by design: the slider IS the input. */}
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-mono text-ink-secondary">
        <span aria-label="Clip start">{formatMmSs(startMs)}</span>
        <span
          className={
            span < minSpanMs || span > maxSpanMs
              ? 'text-signal-warn'
              : 'text-ink-tertiary'
          }
        >
          ({formatClipDuration(Math.max(0, span))})
        </span>
        <span aria-label="Clip end">{formatMmSs(endMs)}</span>
      </div>

      {/* Track + handles. The track is generous in vertical space so
          touch targets stay >= 24px without making the timeline visually
          bulky — the actual rail line is 6px tall, the touch zone is the
          full ~24px container. */}
      <div
        ref={trackRef}
        className="relative h-6 w-full cursor-pointer"
        aria-disabled={disabled}
      >
        {/* Rail */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
        {/* Selected region */}
        <div
          className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/50"
          style={{
            left: `${startPct}%`,
            width: `${Math.max(0, endPct - startPct)}%`,
          }}
        />
        {/* Ticks */}
        {ticks.map((t) => {
          const pct = ((t - timelineStartMs) / timelineSpan) * 100;
          if (pct < 0 || pct > 100) return null;
          return (
            <span
              key={t}
              className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 bg-line-subtle"
              style={{ left: `${pct}%` }}
              aria-hidden
            />
          );
        })}

        {/* Played-progress fill — grows inside the selected region as
            the preview player advances. Darker than the selected
            region so the eye reads it as "played so far" vs. "clip
            range" — same visual idiom as a video scrubber. */}
        {playheadMs != null &&
          playheadMs >= startMs &&
          playheadMs <= endMs && (
            <div
              className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-ink-primary"
              style={{
                left: `${startPct}%`,
                width: `${clamp(
                  ((playheadMs - startMs) / timelineSpan) * 100,
                  0,
                  100,
                )}%`,
              }}
              aria-hidden
            />
          )}

        {/* Live playhead — a high-contrast vertical bar with a circle
            knob on top so the position is unmistakable even when the
            clip range is narrow relative to the visible timeline. Sits
            above the handle hit boxes in source order but is
            pointer-events-none so handle drags still win. */}
        {playheadMs != null &&
          playheadMs >= timelineStartMs &&
          playheadMs <= timelineEndMs && (
            <span
              className="pointer-events-none absolute top-0 grid h-6 -translate-x-1/2 place-items-center"
              style={{
                left: `${clamp(
                  ((playheadMs - timelineStartMs) / timelineSpan) * 100,
                  0,
                  100,
                )}%`,
              }}
              aria-hidden
            >
              <span className="absolute top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-ink-primary shadow-[0_0_0_1px_rgba(255,255,255,0.9)]" />
              <span className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-white bg-ink-primary shadow-md" />
            </span>
          )}

        {/* Start handle */}
        <button
          type="button"
          aria-label="Clip start handle"
          aria-valuemin={timelineStartMs}
          aria-valuemax={endMs - minSpanMs}
          aria-valuenow={startMs}
          aria-valuetext={formatMmSs(startMs)}
          role="slider"
          disabled={disabled}
          onPointerDown={onPointerDown('start')}
          onKeyDown={onKey('start')}
          className={[
            'absolute top-1/2 grid h-5 w-3.5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-sm border border-accent bg-white shadow',
            'cursor-ew-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
            dragging === 'start' ? 'ring-2 ring-accent' : '',
            disabled ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
          style={{ left: `${startPct}%` }}
        >
          <span className="block h-2.5 w-px bg-accent" aria-hidden />
        </button>

        {/* End handle */}
        <button
          type="button"
          aria-label="Clip end handle"
          aria-valuemin={startMs + minSpanMs}
          aria-valuemax={timelineEndMs}
          aria-valuenow={endMs}
          aria-valuetext={formatMmSs(endMs)}
          role="slider"
          disabled={disabled}
          onPointerDown={onPointerDown('end')}
          onKeyDown={onKey('end')}
          className={[
            'absolute top-1/2 grid h-5 w-3.5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-sm border border-accent bg-white shadow',
            'cursor-ew-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
            dragging === 'end' ? 'ring-2 ring-accent' : '',
            disabled ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
          style={{ left: `${endPct}%` }}
        >
          <span className="block h-2.5 w-px bg-accent" aria-hidden />
        </button>
      </div>

      {/* Bottom-axis labels — bookend the visible timeline so the
          reviewer has a frame of reference for the handle positions. */}
      <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-ink-tertiary">
        <span>{formatMmSs(timelineStartMs)}</span>
        <span>{formatMmSs(timelineEndMs)}</span>
      </div>
    </div>
  );
}
