'use client';

// MuxClipPreview — per-step clip preview for the admin draft reviewer.
// Renders an animated GIF-like preview using Mux's image API (which is
// always available; .mp4 renditions require static_renditions enabled
// on the asset, which our uploads don't set). The animated GIF preview
// loops through ~10 frames from inside the clip window, so the admin can
// see what motion the step contains without setting up an HLS player.
//
// On click, we swap to a real <video> playing the Mux .mp4 — which falls
// back gracefully to the static thumbnail if mp4_support isn't enabled.
// That keeps the admin able to "tap to play" when it works, without
// blocking the preview when it doesn't.

import { useState } from 'react';
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
  const [showPlayer, setShowPlayer] = useState(false);

  const startSec = Math.max(0, Math.floor(startMs / 1000));
  const endSec = Math.max(startSec + 1, Math.ceil(endMs / 1000));
  const midSec = Math.floor((startSec + endSec) / 2);

  const isPortrait =
    orientation === 'portrait' ||
    (aspectRatio
      ? (() => {
          const m = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
          if (!m) return false;
          return Number(m[1]) < Number(m[2]);
        })()
      : false);

  // Mux animated GIF endpoint — loops frames from [start, end] over `fps`
  // captures. Doesn't require any asset config; works on every public
  // playback id. Capped to ~10s window because longer animated GIFs are
  // huge and slow to render.
  const animSpan = Math.min(endSec - startSec, 10);
  const animatedSrc = `https://image.mux.com/${playbackId}/animated.gif?start=${startSec}&end=${startSec + animSpan}&fps=6&width=480`;
  const stillSrc = `https://image.mux.com/${playbackId}/thumbnail.jpg?time=${midSec}&width=480`;
  const mp4Src = `https://stream.mux.com/${playbackId}/medium.mp4`;

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
      {showPlayer ? (
        // Tap-to-play: try the .mp4 rendition. If the asset doesn't have
        // static renditions enabled (the default for our uploads), the
        // video errors silently and we fall back to the animated preview.
        <video
          src={mp4Src + `#t=${startSec},${endSec}`}
          controls
          autoPlay
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
          onError={() => setShowPlayer(false)}
        />
      ) : (
        <>
          <img
            src={animatedSrc}
            alt="Step preview"
            className="h-full w-full object-cover"
            // If the animated GIF fails to load, show the still keyframe
            // instead of an empty box.
            onError={(e) => {
              const img = e.currentTarget;
              if (img.src !== stillSrc) img.src = stillSrc;
            }}
          />
          <button
            type="button"
            onClick={() => setShowPlayer(true)}
            aria-label="Play clip"
            className="absolute inset-0 grid place-items-center bg-black/20 opacity-0 transition hover:opacity-100"
          >
            <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-black shadow">
              <Play size={20} strokeWidth={2.5} fill="currentColor" />
            </span>
          </button>
        </>
      )}
    </div>
  );
}
