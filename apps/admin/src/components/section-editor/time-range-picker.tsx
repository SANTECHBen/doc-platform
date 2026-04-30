'use client';

import { useEffect, useRef, useState } from 'react';
import { Field, SecondaryButton, TextInput } from '@/components/form';
import type { AdminDocumentDetail } from '@/lib/api';

// Time-range picker for video / external_video. Renders the source video
// inline; admin scrubs to the start, hits "Set start", scrubs to the end,
// hits "Set end". Numeric inputs are also editable for precision.

export function TimeRangePicker({
  doc,
  startSeconds,
  endSeconds,
  onChange,
}: {
  doc: AdminDocumentDetail;
  startSeconds: number;
  endSeconds: number;
  onChange: (start: number, end: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  function setStartHere() {
    const v = videoRef.current;
    if (!v) return;
    onChange(roundT(v.currentTime), Math.max(roundT(v.currentTime) + 1, endSeconds));
  }

  function setEndHere() {
    const v = videoRef.current;
    if (!v) return;
    onChange(startSeconds, Math.max(startSeconds + 1, roundT(v.currentTime)));
  }

  function seekTo(seconds: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, seconds);
    void v.play();
  }

  if (!doc.fileUrl) {
    return (
      <div className="rounded-md border border-dashed border-line bg-surface p-4 text-sm text-ink-tertiary">
        No playable URL on this document. Upload the source video first.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Source video">
        <video
          ref={videoRef}
          src={doc.fileUrl}
          controls
          preload="metadata"
          className="aspect-video w-full rounded border border-line-subtle bg-black"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Start (seconds)" required>
          <div className="flex items-center gap-2">
            <TextInput
              type="number"
              min={0}
              step="0.1"
              value={startSeconds}
              onChange={(e) =>
                onChange(Math.max(0, Number(e.target.value) || 0), endSeconds)
              }
              required
            />
            <SecondaryButton type="button" onClick={setStartHere}>
              From video
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => seekTo(startSeconds)}>
              ▶
            </SecondaryButton>
          </div>
        </Field>
        <Field label="End (seconds)" required>
          <div className="flex items-center gap-2">
            <TextInput
              type="number"
              min={startSeconds}
              step="0.1"
              value={endSeconds}
              onChange={(e) =>
                onChange(
                  startSeconds,
                  Math.max(startSeconds + 1, Number(e.target.value) || startSeconds + 1),
                )
              }
              required
            />
            <SecondaryButton type="button" onClick={setEndHere}>
              From video
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => seekTo(endSeconds - 1)}>
              ▶
            </SecondaryButton>
          </div>
        </Field>
      </div>

      <p className="text-xs text-ink-tertiary">
        Selected window: {fmt(startSeconds)} – {fmt(endSeconds)} (
        {fmt(endSeconds - startSeconds)})
        {duration != null && ` of ${fmt(duration)}`}
      </p>
    </div>
  );
}

function roundT(t: number): number {
  return Math.round(t * 10) / 10;
}

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
