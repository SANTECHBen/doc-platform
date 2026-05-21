'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize } from 'lucide-react';

// StepVideoPlayer — drop-in replacement for the raw <video> tag in
// procedure step media galleries (and the hero video on Step 0 / scroll
// view). Built for short technique clips that should behave like an
// animated GIF: autoplay, loop, muted by default. Native controls let
// the tech pause/unmute/scrub if they want.
//
// Behaviors:
//   - Autoplay + loop on mount. Muted by default so the browser allows
//     autoplay without a user gesture. Set `muted={false}` to ship with
//     audio enabled (browsers will still require a tap before unmuting
//     in most cases, but the file's track is wired up).
//   - Auto-pause + reset when playId changes (next/prev step nav) so
//     audio doesn't leak across steps in the Job Aid runner.
//   - Native controls always available — pause, scrub, unmute, full-
//     screen — overlaid on the player chrome at the bottom.
//   - Tap-to-fullscreen button stays in the corner with iOS Safari
//     webkit fallback for old devices.
//   - On load error, falls back to a labeled placeholder.

interface Props {
  src: string;
  alt?: string;
  caption?: string | null;
  /** Defaults to true — autoplay won't fire on mobile without it.
   *  Pass false only when you need the video to ship with audio on
   *  by default (rare; the tech can always unmute via the controls). */
  muted?: boolean;
  /** Stable identifier whose change triggers an auto-pause + reset.
   *  Pass the step id when used per-step; pass "hero" for hero video. */
  playId: string;
  className?: string;
}

export function StepVideoPlayer({
  src,
  alt,
  caption,
  muted = true,
  playId,
  className,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);

  // Re-arm autoplay whenever playId changes. The browser pauses videos
  // that scroll out of view on iOS, and we want the next step's clip to
  // start fresh — set currentTime to 0 and call play() defensively.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = 0;
      void v.play().catch(() => {
        // Autoplay policy refused — user will see the static frame +
        // controls and can tap play. Not fatal.
      });
    } catch {
      // already inert
    }
  }, [playId]);

  function enterFullscreen(e: React.MouseEvent) {
    e.stopPropagation();
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v) return;
    // iOS Safari: video element has a non-standard fullscreen API on
    // the element itself rather than via document.fullscreenElement.
    const webkitVideo = v as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    if (typeof webkitVideo.webkitEnterFullscreen === 'function') {
      webkitVideo.webkitEnterFullscreen();
      return;
    }
    if (typeof v.requestFullscreen === 'function') {
      void v.requestFullscreen().catch(() => {});
    }
  }

  if (failed || !src) {
    return (
      <div
        className={`step-video-frame step-video-fallback ${className ?? ''}`}
        role="img"
        aria-label={alt ?? caption ?? 'Video unavailable'}
      >
        <span aria-hidden>🎞️</span>
        <span>{caption ?? 'Video unavailable'}</span>
      </div>
    );
  }

  return (
    <figure className={`step-video-frame ${className ?? ''}`}>
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        playsInline
        autoPlay
        loop
        preload="auto"
        controls
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="step-video-fs-btn"
        onClick={enterFullscreen}
        aria-label="Enter fullscreen"
      >
        <Maximize size={16} strokeWidth={2} />
      </button>
      {caption && <figcaption className="step-video-caption">{caption}</figcaption>}
    </figure>
  );
}
