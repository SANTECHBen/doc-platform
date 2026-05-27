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
// carries a video_clip entry (drafter-built steps). Behavior:
//
//   * The preview plays the trimmed clip with audio enabled so the
//     reviewer can hear the cut. Re-mints the Mux URL on every range
//     change — auditioning a tighter cut is one save away.
//   * Two mm:ss inputs for start/end + a duration readout. Same parser
//     as the draft editor (lib/clip-time.ts).
//   * Save button PATCHes /admin/procedure-steps/:id/clip-range. The
//     server validates 2–20s; this UI mirrors that as a visual warning
//     instead of a hard block so authors aren't fighting mid-edit.
//   * No autosave. Trim is a deliberate action and a stray keystroke
//     should not retrigger Mux clipping or invalidate the PWA's cached
//     clip URL on every running tech's device.

import { useEffect, useState } from 'react';
import { Loader2, Save, Scissors, Undo2 } from 'lucide-react';
import {
  updateProcedureStepClipRange,
  type AdminProcedureStep,
  type AdminStepMedia,
} from '@/lib/api';
import { MuxClipAudioPreview } from '@/components/mux-clip-audio-preview';
import { formatMmSs, parseMmSs, formatClipDuration } from '@/lib/clip-time';
import { useToast } from '@/components/toast';

const MIN_MS = 2_000;
const MAX_MS = 20_000;

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
  // Local edit state, separate from the saved values so an in-flight
  // edit isn't clobbered by a parent re-render with the old numbers.
  // Initialized lazily so re-renders during typing don't reset cursor
  // position.
  const initialStart = clipMedia?.clip.startMs ?? 0;
  const initialEnd = clipMedia?.clip.endMs ?? 0;
  const [startMs, setStartMs] = useState(initialStart);
  const [endMs, setEndMs] = useState(initialEnd);
  // Mirror the persisted values so we can detect "dirty" and offer Undo.
  const [savedStart, setSavedStart] = useState(initialStart);
  const [savedEnd, setSavedEnd] = useState(initialEnd);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Re-sync from the parent when a different step lands here (e.g., the
  // author switched cards). We key the panel by step.id at the call site
  // but also guard against in-place media changes (StepVideosPanel
  // upload, voiceover panel re-attach) that shouldn't reset our edits.
  useEffect(() => {
    const next = findVideoClip(step);
    if (!next) return;
    setStartMs(next.clip.startMs);
    setEndMs(next.clip.endMs);
    setSavedStart(next.clip.startMs);
    setSavedEnd(next.clip.endMs);
  }, [step.id]);

  if (!clipMedia) return null;

  const dirty = startMs !== savedStart || endMs !== savedEnd;
  const span = endMs - startMs;
  const tooShort = span < MIN_MS;
  const tooLong = span > MAX_MS;
  const invertedRange = endMs <= startMs;
  const canSave =
    dirty && !invertedRange && !tooShort && !tooLong && !saving;

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const next = await updateProcedureStepClipRange(step.id, {
        startMs,
        endMs,
      });
      onChanged(next);
      const updated = findVideoClip(next);
      if (updated) {
        setSavedStart(updated.clip.startMs);
        setSavedEnd(updated.clip.endMs);
        setStartMs(updated.clip.startMs);
        setEndMs(updated.clip.endMs);
      }
      toast.success('Clip range updated');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error('Clip range save failed', message);
    } finally {
      setSaving(false);
    }
  }

  function onUndo() {
    setStartMs(savedStart);
    setEndMs(savedEnd);
    setError(null);
  }

  return (
    <div className="rounded-md border border-line-subtle bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <Scissors className="size-3.5 text-ink-tertiary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          Walkthrough clip
        </span>
        <span className="text-xs text-ink-tertiary">
          Trim the looped clip the tech sees while running this step.
        </span>
      </div>

      <div className="mb-2.5">
        <MuxClipAudioPreview
          playbackId={clipMedia.clip.playbackId}
          startMs={startMs}
          endMs={endMs}
          aspectRatio={clipMedia.clip.aspectRatio ?? null}
          orientation={clipMedia.clip.orientation ?? null}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-ink-tertiary">Start</span>
          <input
            type="text"
            inputMode="numeric"
            value={formatMmSs(startMs)}
            onChange={(e) => {
              const ms = parseMmSs(e.target.value);
              if (ms != null) setStartMs(ms);
            }}
            disabled={saving}
            className="w-16 rounded border border-line bg-surface-inset px-1.5 py-1 text-center font-mono text-[12px] text-ink-primary focus:border-accent focus:outline-none disabled:opacity-50"
            aria-label="Clip start"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-ink-tertiary">End</span>
          <input
            type="text"
            inputMode="numeric"
            value={formatMmSs(endMs)}
            onChange={(e) => {
              const ms = parseMmSs(e.target.value);
              if (ms != null) setEndMs(ms);
            }}
            disabled={saving}
            className="w-16 rounded border border-line bg-surface-inset px-1.5 py-1 text-center font-mono text-[12px] text-ink-primary focus:border-accent focus:outline-none disabled:opacity-50"
            aria-label="Clip end"
          />
        </label>
        <span
          className={[
            'font-mono text-[11px]',
            invertedRange || tooShort || tooLong
              ? 'text-signal-warn'
              : 'text-ink-tertiary',
          ].join(' ')}
        >
          ({formatClipDuration(Math.max(0, span))})
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
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!canSave}
          className="ml-auto inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-accent-strong disabled:opacity-40"
        >
          {saving ? (
            <>
              <Loader2 size={11} className="animate-spin" /> Saving…
            </>
          ) : (
            <>
              <Save size={11} /> Save trim
            </>
          )}
        </button>
      </div>

      {(invertedRange || tooShort || tooLong) && (
        <p className="mt-1.5 text-[11px] text-signal-warn">
          {invertedRange
            ? 'End must be after Start.'
            : tooShort
              ? `Clip must be at least ${formatClipDuration(MIN_MS)}.`
              : `Clip must be at most ${formatClipDuration(MAX_MS)}.`}
        </p>
      )}
      {error && !invertedRange && !tooShort && !tooLong && (
        <p className="mt-1.5 text-[11px] text-signal-fault">{error}</p>
      )}
    </div>
  );
}
