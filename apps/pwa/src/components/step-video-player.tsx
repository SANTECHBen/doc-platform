'use client';

import { useEffect, useRef, useState } from 'react';
import { Maximize, Play } from 'lucide-react';

// StepVideoPlayer — drop-in replacement for the raw <video> tag in
// procedure step media galleries (and the hero video on Step 0 / scroll
// view).
//
// Step-video mode (default): autoplay + loop + muted. Behaves like an
// animated GIF — each step's clip starts the moment the step renders
// and loops until the tech moves on. Native controls stay available
// so a tech can pause, scrub, unmute, or fullscreen.
//
// Hero-video mode (`autoplay={false}`): explicit tap to play. The hero
// is a longer intro clip the author wants the tech to engage with
// intentionally, not background motion. Shows a large play overlay;
// native controls + fullscreen button appear after first interaction.
//
// In both modes:
//   - Auto-pause + reset when playId changes so audio doesn't leak
//     across steps in the Job Aid runner.
//   - iOS Safari webkit fullscreen API fallback for old devices.
//   - On load error, falls back to a labeled placeholder.

interface Props {
  src: string;
  alt?: string;
  caption?: string | null;
  /** Muted on load. Defaults true. Required to be true for autoplay to
   *  succeed on mobile per browser autoplay policy. */
  muted?: boolean;
  /** Autoplay + loop on mount. Step videos default to true; the hero
   *  video on Step 0 passes false so the tech taps to start the intro. */
  autoplay?: boolean;
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
  autoplay = true,
  playId,
  className,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(autoplay);
  const [failed, setFailed] = useState(false);

  // Re-arm playback whenever playId changes. In autoplay mode this
  // restarts the loop for the next step's clip; in tap-to-play mode it
  // resets to the pre-tap state.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.pause();
      v.currentTime = 0;
    } catch {
      // already inert
    }
    if (autoplay) {
      setStarted(true);
      void v.play().catch(() => {
        // Autoplay policy refused — fall back to tap-to-play so the
        // user sees the play overlay instead of a frozen first frame.
        setStarted(false);
      });
    } else {
      setStarted(false);
    }
  }, [playId, autoplay]);

  function startPlayback() {
    const v = videoRef.current;
    if (!v) return;
    setStarted(true);
    void v.play().catch(() => {
      // Some browsers reject play() if the gesture didn't satisfy
      // policy. Native controls become visible regardless, so the
      // user can retry with the native play button.
    });
  }

  function enterFullscreen(e: React.MouseEvent) {
    e.stopPropagation();
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v) return;
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
        autoPlay={autoplay}
        loop={autoplay}
        preload={autoplay ? 'auto' : 'metadata'}
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
