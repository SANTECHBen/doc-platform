'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize, Play } from 'lucide-react';

// StepVideoPlayer — drop-in replacement for the raw <video> tag in
// procedure step media galleries (and the hero video on Step 0 / scroll
// view). Built for hands-free contexts where the procedure runner has
// TTS narration, but also works fine in plain-read browse mode.
//
// Behaviors (per plan):
//   - Auto-pause when playId changes (next/prev step navigation).
//   - Muted by default when `muted` prop is true (Job Aid + voice mode).
//   - 16:9 framed play surface with brand-tinted border + rounded
//     corners — feels intentional vs. raw native player chrome.
//   - Custom large play overlay before first interaction; native
//     controls appear after the user starts playback.
//   - Tap-to-fullscreen button in the bottom-right corner using the
//     native Fullscreen API (with webkit fallback for iOS Safari).
//   - On load error, falls back to a labeled placeholder.

interface Props {
  src: string;
  alt?: string;
  caption?: string | null;
  /** Start muted (Job Aid view passes true to avoid fighting TTS). */
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
  muted = false,
  playId,
  className,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  // Auto-pause + reset whenever the parent's playId changes. Prevents
  // audio leaking across step transitions in the Job Aid view.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.pause();
      v.currentTime = 0;
    } catch {
      // already inert
    }
    setStarted(false);
  }, [playId]);

  function startPlayback() {
    const v = videoRef.current;
    if (!v) return;
    setStarted(true);
    void v.play().catch(() => {
      // Some browsers reject play() if the gesture didn't satisfy
      // policy. The native controls become visible regardless, so the
      // user can retry with the native play button.
    });
  }

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
        preload="metadata"
        controls={started}
        onError={() => setFailed(true)}
      />
      {!started && (
        <button
          type="button"
          className="step-video-overlay"
          onClick={startPlayback}
          aria-label={alt ?? 'Play video'}
        >
          <span className="step-video-play-circle" aria-hidden>
            <Play size={28} strokeWidth={2.5} fill="currentColor" />
          </span>
        </button>
      )}
      {started && (
        <button
          type="button"
          className="step-video-fs-btn"
          onClick={enterFullscreen}
          aria-label="Enter fullscreen"
        >
          <Maximize size={16} strokeWidth={2} />
        </button>
      )}
      {caption && started && (
        <figcaption className="step-video-caption">{caption}</figcaption>
      )}
    </figure>
  );
}
