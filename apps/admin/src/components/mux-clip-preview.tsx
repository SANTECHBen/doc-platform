'use client';

// MuxClipPreview — lightweight per-step clip preview for the admin
// draft reviewer. Uses the Mux .mp4 rendition (low.mp4 is sufficient for
// preview quality) clamped via currentTime to [startMs, endMs]. Reuses
// hls.js when available but falls back cleanly to <video src=".mp4">.
//
// This is a deliberately smaller cousin of the PWA's mux-clip-player —
// admins don't need autoplay loops, just a quick "is this the right cut?"
// preview. Tap to play, taps end → seeks back to start, tap again to
// replay. The compact frame respects the source orientation so portrait
// clips render in a tall preview, matching what the tech will see.

import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';

interface Props {
  playbackId: string;
  startMs: number;
  endMs: number;
  /** "16:9", "9:16", "1:1" — drives the preview container's aspect-ratio. */
  aspectRatio?: string | null;
  orientation?: 'portrait' | 'landscape' | 'square' | null;
}

function frameAspectRatio(
  ratio?: string | null,
  orientation?: 'portrait' | 'landscape' | 'square' | null,
): string {
  if (ratio) {
    const m = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (m) return `${m[1]} / ${m[2]}`;
  }
  if (orientation === 'portrait') return '9 / 16';
  if (orientation === 'square') return '1 / 1';
  return '16 / 9';
}

export function MuxClipPreview({
  playbackId,
  startMs,
  endMs,
  aspectRatio,
  orientation,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const startSec = Math.max(0, startMs / 1000);
  const endSec = Math.max(startSec + 0.1, endMs / 1000);

  const isPortrait =
    orientation === 'portrait' ||
    (aspectRatio
      ? (() => {
          const m = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
          if (!m) return false;
          return Number(m[1]) < Number(m[2]);
        })()
      : false);

  // Set initial position once metadata is known. Re-runs on prop change
  // so the admin can scrub the clip ends and the preview snaps to the
  // new start.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      try {
        v.currentTime = startSec;
      } catch {
        // Some browsers throw if duration isn't ready yet.
      }
    };
    if (v.readyState >= 1) onMeta();
    v.addEventListener('loadedmetadata', onMeta);
    return () => v.removeEventListener('loadedmetadata', onMeta);
  }, [startSec]);

  // Auto-pause when crossing the clip end.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      if (v.currentTime >= endSec - 0.02) {
        v.pause();
        setPlaying(false);
        try {
          v.currentTime = startSec;
        } catch {
          // ignore
        }
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [startSec, endSec]);

  function onPlayClick() {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = startSec;
    } catch {
      // ignore
    }
    setPlaying(true);
    void v.play().catch(() => setPlaying(false));
  }

  // .mp4 rendition keeps the admin reviewer simple — no hls.js, no MSE.
  // Mux serves low/medium/high .mp4 for any asset; low is fine for a
  // 200px-tall preview window.
  const src = `https://stream.mux.com/${playbackId}/low.mp4`;

  return (
    <div
      className="relative overflow-hidden rounded-md border border-line bg-black"
      style={{
        aspectRatio: frameAspectRatio(aspectRatio, orientation),
        ...(isPortrait
          ? { maxWidth: '180px', marginInline: 'auto' }
          : { width: '100%' }),
      }}
    >
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="metadata"
        controls={playing}
        className="h-full w-full"
        style={{ objectFit: 'contain' }}
      />
      {!playing && (
        <button
          type="button"
          onClick={onPlayClick}
          aria-label="Preview clip"
          className="absolute inset-0 grid place-items-center bg-black/35 transition hover:bg-black/25"
        >
          <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-black shadow">
            <Play size={20} strokeWidth={2.5} fill="currentColor" />
          </span>
        </button>
      )}
    </div>
  );
}
