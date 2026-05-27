'use client';

// WalkthroughClipPanel — post-publish clip-range editor for one step.
//
// AI-walkthrough procedures attach a `video_clip` media entry to each
// step pointing at a [startMs..endMs] window of the source Mux asset.
// The drafter's first pass + the loop-time auto-trim get the cuts most
// of the way there, but admins occasionally need to nudge a few frames
// after the procedure has been published — typically to lop off
// narration that bleeds into the next step's intro.
//
// This panel renders inside the procedure CMS step card, sibling to
// VoiceoverPanel and StepVideosPanel, and only when the step actually
// carries a video_clip entry (drafter-built steps).
//
// Save behavior — autosave on handle release:
//   * The slider's onCommit fires once per pointerup / keyboard nudge.
//     We PATCH /admin/procedure-steps/:id/clip-range with the new
//     bounds at that moment, so the author never has to remember to
//     click a Save button. A persistent "Saved" / "Saving…" indicator
//     shows the state so the action isn't invisible.
//   * Onscreen validation gates the save: bounds in [200ms..20s] and
//     end strictly greater than start. Out-of-range commits show a
//     warning and don't fire the PATCH; the local preview still
//     updates so the author can see what they're dragging into.
//   * Errors surface inline (and via toast) so a server reject doesn't
//     get lost.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Scissors, Undo2 } from 'lucide-react';
import {
  updateProcedureStepClipRange,
  type AdminProcedureStep,
  type AdminStepMedia,
} from '@/lib/api';
import { MuxClipAudioPreview } from '@/components/mux-clip-audio-preview';
import { ClipTrimSlider } from '@/components/clip-trim-slider';
import { formatClipDuration } from '@/lib/clip-time';
import { useToast } from '@/components/toast';

// Hard floor — matches the server's PATCH /clip-range validation. Lower
// than the drafter's 2s LLM target so human trims can dip into the
// "brief motion / single click" range.
const MIN_MS = 200;
const MAX_MS = 20_000;
// "Just saved" indicator dwells for this long after a successful save
// so the author actually sees the confirmation before it disappears.
const SAVED_INDICATOR_MS = 2_000;

interface Props {
  step: AdminProcedureStep;
  onChanged: (next: AdminProcedureStep) => void;
}

type VideoClipMedia = Extract<AdminStepMedia, { kind: 'video_clip' }>;

function findVideoClip(step: AdminProcedureStep): VideoClipMedia | null {
  const media = step.media ?? [];
  for (const m of media) {
    if (m.kind === 'video_clip') return m;
  }
  return null;
}

export function WalkthroughClipPanel({ step, onChanged }: Props) {
  const clipMedia = findVideoClip(step);
  const initialStart = clipMedia?.clip.startMs ?? 0;
  const initialEnd = clipMedia?.clip.endMs ?? 0;
  const [startMs, setStartMs] = useState(initialStart);
  const [endMs, setEndMs] = useState(initialEnd);
  // Mirror the persisted values so we can detect "dirty" and show Undo.
  const [savedStart, setSavedStart] = useState(initialStart);
  const [savedEnd, setSavedEnd] = useState(initialEnd);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live playback position threaded from the preview player into the
  // trim slider so the reviewer can see where the loop currently is.
  // Null when nothing is playing.
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  // Track the most recent autosave we kicked off so a slow first save
  // can't clobber a faster second save (last-write-wins on the bounds
  // the user landed on, not whichever PATCH happens to resolve last).
  const inFlightTokenRef = useRef(0);
  const savedIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const toast = useToast();

  // Re-sync from the parent when a different step lands here (e.g., the
  // author switched cards). Key by step.id so in-place media changes
  // from sibling panels (audio upload, etc.) don't reset our edits.
  useEffect(() => {
    const next = findVideoClip(step);
    if (!next) return;
    setStartMs(next.clip.startMs);
    setEndMs(next.clip.endMs);
    setSavedStart(next.clip.startMs);
    setSavedEnd(next.clip.endMs);
  }, [step.id]);

  useEffect(
    () => () => {
      if (savedIndicatorTimerRef.current) {
        clearTimeout(savedIndicatorTimerRef.current);
      }
    },
    [],
  );

  // Persist a (startMs, endMs) commit. Returns silently when bounds are
  // out of range — the validation message in the UI tells the author
  // what's wrong, and we don't want to PATCH a value the server will
  // reject anyway.
  const save = useCallback(
    async (next: { startMs: number; endMs: number }) => {
      const nextSpan = next.endMs - next.startMs;
      if (next.endMs <= next.startMs) return;
      if (nextSpan < MIN_MS || nextSpan > MAX_MS) return;
      if (next.startMs === savedStart && next.endMs === savedEnd) return;
      const token = ++inFlightTokenRef.current;
      setSaving(true);
      setError(null);
      try {
        const updatedStep = await updateProcedureStepClipRange(step.id, next);
        // A later commit superseded this one before the server
        // returned. Don't apply the older response, otherwise we'd
        // briefly show stale bounds before the in-flight call lands.
        if (token !== inFlightTokenRef.current) return;
        onChanged(updatedStep);
        const updatedClip = findVideoClip(updatedStep);
        if (updatedClip) {
          setSavedStart(updatedClip.clip.startMs);
          setSavedEnd(updatedClip.clip.endMs);
        }
        setJustSaved(true);
        if (savedIndicatorTimerRef.current) {
          clearTimeout(savedIndicatorTimerRef.current);
        }
        savedIndicatorTimerRef.current = setTimeout(
          () => setJustSaved(false),
          SAVED_INDICATOR_MS,
        );
      } catch (e) {
        if (token !== inFlightTokenRef.current) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        toast.error('Clip range save failed', message);
      } finally {
        if (token === inFlightTokenRef.current) {
          setSaving(false);
        }
      }
    },
    [step.id, savedStart, savedEnd, onChanged, toast],
  );

  function onUndo() {
    setStartMs(savedStart);
    setEndMs(savedEnd);
    setError(null);
  }

  if (!clipMedia) return null;

  const dirty = startMs !== savedStart || endMs !== savedEnd;
  const span = endMs - startMs;
  const tooShort = span < MIN_MS;
  const tooLong = span > MAX_MS;
  const invertedRange = endMs <= startMs;
  const invalid = invertedRange || tooShort || tooLong;

  return (
    <div className="rounded-md border border-line-subtle bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <Scissors className="size-3.5 text-ink-tertiary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          Walkthrough clip
        </span>
        <span className="text-xs text-ink-tertiary">
          Drag the handles to trim — saves on release.
        </span>
      </div>

      <div className="mb-2.5">
        <MuxClipAudioPreview
          playbackId={clipMedia.clip.playbackId}
          startMs={startMs}
          endMs={endMs}
          aspectRatio={clipMedia.clip.aspectRatio ?? null}
          orientation={clipMedia.clip.orientation ?? null}
          voiceoverUrl={step.audioUrl}
          onTimeUpdate={(ms) => setPlayheadMs(ms)}
        />
      </div>

      <div className="mb-2.5">
        <ClipTrimSlider
          startMs={startMs}
          endMs={endMs}
          // Context window around the saved trim. Drafter writes only
          // clip bounds + playback id on procedure_steps.media; we don't
          // have source duration locally. ±10s is enough headroom for
          // the typical "shave a few seconds" use case.
          timelineStartMs={Math.max(0, savedStart - 10_000)}
          timelineEndMs={savedEnd + 10_000}
          minSpanMs={MIN_MS}
          maxSpanMs={MAX_MS}
          disabled={saving}
          playheadMs={playheadMs}
          onChange={(next) => {
            setStartMs(next.startMs);
            setEndMs(next.endMs);
          }}
          // Auto-save on pointerup / keyboard commit. The slider fires
          // this once per "release" instead of on every drag tick, so
          // dragging across the bar generates exactly one PATCH at the
          // settled position — same UX a video editor's scrubbing
          // behavior would have.
          onCommit={(next) => void save(next)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span
          className={[
            'font-mono text-[11px]',
            invalid ? 'text-signal-warn' : 'text-ink-tertiary',
          ].join(' ')}
        >
          Clip: {formatClipDuration(Math.max(0, span))}
        </span>
        {dirty && (
          <button
            type="button"
            onClick={onUndo}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface-inset px-2 py-1 text-[11px] font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
            aria-label="Revert to saved clip range"
          >
            <Undo2 size={11} /> Revert
          </button>
        )}
        <div
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium"
          aria-live="polite"
        >
          {saving ? (
            <span className="inline-flex items-center gap-1 text-ink-secondary">
              <Loader2 size={11} className="animate-spin" /> Saving…
            </span>
          ) : justSaved ? (
            <span className="inline-flex items-center gap-1 text-signal-ok">
              <CheckCircle2 size={11} /> Saved
            </span>
          ) : dirty && invalid ? (
            <span className="text-signal-warn">Adjust to save</span>
          ) : null}
        </div>
      </div>

      {invalid && (
        <p className="mt-1.5 text-[11px] text-signal-warn">
          {invertedRange
            ? 'End must be after Start.'
            : tooShort
              ? `Clip must be at least ${formatClipDuration(MIN_MS)}.`
              : `Clip must be at most ${formatClipDuration(MAX_MS)}.`}
        </p>
      )}
      {error && !invalid && (
        <p className="mt-1.5 text-[11px] text-signal-fault">{error}</p>
      )}
    </div>
  );
}
