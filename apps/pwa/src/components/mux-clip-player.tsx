'use client';

// MuxClipPlayer — plays a Mux instant-clip HLS stream natively.
//
// The server hands us a per-step URL like
//   https://stream.mux.com/<id>.m3u8?asset_start_time=10&asset_end_time=20
// (or the signed-JWT equivalent). The manifest at that URL represents
// ONLY the clip range — Mux's edge does the slicing. So from this
// component's perspective the stream is a small standalone HLS file:
// the `loop` attribute loops the clip, `currentTime` is relative to
// the clip's start, and there is no per-step seek/wrap bookkeeping.
// Everything that used to live here for that — startMs/endMs props,
// the seek-to-startMs effect, the timeupdate wrap, the poster cover
// that masked iOS Safari's seek artifacts, the forwardRef imperative
// pause handle — went away when we moved server-side to instant clip
// URLs in `packages/api/src/lib/mux.ts`. The result is a thin wrapper
// over `<video>`, with just the HLS-attach plumbing (Safari uses the
// .m3u8 directly; everything else needs hls.js).
//
// Playback strategy
// -----------------
// 1. Safari / iOS / iPadOS: HTMLMediaElement plays HLS natively. We
//    just assign `<video src>`.
// 2. Other browsers: hls.js is lazy-loaded on first render and
//    attached via MediaSource Extensions. The lazy import keeps the
//    dep out of the initial PWA bundle for HLS-native devices.
//
// Poster + fallback
// -----------------
// `posterUrl` is the storage-resolved keyframe JPEG (extracted by the
// drafter executor at proposal time). It paints before HLS loads and
// stays as the fallback if HLS fails on this device. If both the poster
// and the stream fail, we render a labeled placeholder so the tech sees
// something rather than a black frame.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';

interface Props {
  /** Per-step Mux instant-clip HLS URL (see muxClipUrlFor on the
   *  server). The manifest is pre-trimmed to the clip range, so we
   *  treat this as a normal standalone HLS source. */
  streamUrl: string;
  /** Storage-resolved JPEG URL. Shown as poster while HLS loads and
   *  as the fallback if HLS fails. */
  posterUrl?: string;
  alt?: string;
  caption?: string | null;
  /** Autoplay + loop on mount. Default true — step clips behave like
   *  animated GIFs. Authors can opt out (e.g., on the doc viewer page
   *  where step cards stack and we don't want a dozen simultaneous
   *  videos) by passing false. When this prop flips at runtime
   *  (active step changes in the Reels viewport), the player calls
   *  play() or pause() accordingly. */
  autoplay?: boolean;
  /** Source aspect ratio Mux reported ("16:9", "9:16", "4:3", "1:1"). When
   *  provided, the container frames the clip in matching aspect — portrait
   *  clips render in a tall frame instead of a letterboxed wide one. Falls
   *  back to landscape (16:9) when missing or unparseable. */
  aspectRatio?: string | null;
  /** Pre-classified orientation. Same data as aspectRatio but cheaper for
   *  the runner to consume (no parsing). Defaults to 'landscape'. */
  orientation?: 'portrait' | 'landscape' | 'square' | null;
  /** Enable tap-anywhere-on-the-video toggle (pause/play) with a brief
   *  flashed icon overlay, à la YouTube Shorts. Off by default — only
   *  the Reels viewport opts in. The classic step card sits inside a
   *  scrollable list and shouldn't steal scroll-area taps for playback. */
  tapToPause?: boolean;
  className?: string;
}

/** Pick a CSS aspect-ratio string for the container. We honor the
 *  caller-provided ratio when it's parseable; otherwise derive one from
 *  the orientation enum (portrait→9/16, square→1/1, else 16/9). */
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

// We never call into the hls.js types directly — the dynamic-import
// lazy path means the types resolve to a `typeof import('hls.js')`
// namespace that this component doesn't model. We narrow to the small
// surface we actually use (constructor + Events + isSupported) at the
// call site via a local interface; the loader returns `unknown` so the
// callsite can cast cleanly.

let hlsModulePromise: Promise<unknown> | null = null;

function loadHlsModule(): Promise<unknown> {
  if (!hlsModulePromise) {
    hlsModulePromise = import('hls.js').then((m) => {
      // hls.js ships with a default export; some bundlers expose it on
      // .default, others on the namespace itself.
      const mod = m as { default?: unknown };
      return mod.default ?? m;
    });
  }
  return hlsModulePromise;
}

export function MuxClipPlayer({
  streamUrl,
  posterUrl,
  alt,
  caption,
  autoplay = true,
  aspectRatio,
  orientation,
  tapToPause = false,
  className,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // hls.js instance — captured for cleanup. Null on Safari / before
  // first attach.
  const hlsRef = useRef<unknown>(null);
  // Whether playback has started (or we expect it to imminently). When
  // false, the tap-to-play overlay is shown. Set true at mount when
  // autoplay is requested; flipped back to false if the browser refuses
  // the autoplay request, so the user has a clear "tap to play" affordance.
  const [started, setStarted] = useState(autoplay);
  // Whether the HLS source or the poster has failed. When `failed` is
  // set and we still have a poster, we render the poster JPEG as a
  // static fallback. When both fail, we render a labeled placeholder.
  const [failed, setFailed] = useState(false);
  // Loop-progress within the clip, 0..1. Drives the thin bottom bar
  // so techs see where in the (looping) clip they are without unmuting
  // or scrubbing. Resets to 0 each loop wrap because the browser
  // resets `currentTime` to 0.
  const [progress, setProgress] = useState(0);
  // Tap-to-pause state. `userPaused` tracks whether the *tech* paused
  // playback. `flash` paints the YouTube-Shorts-style transient icon
  // on every toggle and clears itself via a single timer.
  const [userPaused, setUserPaused] = useState(false);
  const [flash, setFlash] = useState<'pause' | 'play' | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Attach the HLS source. On Safari / iOS we set src directly (native
  // HLS); elsewhere we dynamic-import hls.js and pipe MSE buffers in.
  // We re-attach when streamUrl changes — including when the parent
  // swaps the per-step clip URL for a new step in classic-mode media
  // galleries that render different clips for different steps.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    setFailed(false);

    // Tear down any prior hls.js instance from a previous mount/url.
    const teardownHls = () => {
      const inst = hlsRef.current as { destroy?: () => void } | null;
      if (inst && typeof inst.destroy === 'function') {
        try {
          inst.destroy();
        } catch {
          // best-effort
        }
      }
      hlsRef.current = null;
    };

    // canPlayType returns 'probably' | 'maybe' | '' — anything non-empty
    // means the browser will try. Safari returns 'maybe' for HLS.
    const canPlayHlsNatively =
      v.canPlayType('application/vnd.apple.mpegurl') !== '' ||
      v.canPlayType('application/vnd.apple.mpegURL') !== '';

    if (canPlayHlsNatively) {
      v.src = streamUrl;
      return () => {
        cancelled = true;
        teardownHls();
        // Detaching the src releases the network handle. Setting empty
        // string and calling load() is the standard idiom.
        try {
          v.removeAttribute('src');
          v.load();
        } catch {
          // ignore — element may already be detached
        }
      };
    }

    // MSE path — load hls.js on demand. We only attach when this
    // codepath is reached, so HLS-native devices never pay for the dep.
    void loadHlsModule()
      .then((HlsModule) => {
        if (cancelled) return;
        const Hls = HlsModule as {
          isSupported: () => boolean;
          new (cfg?: unknown): {
            loadSource: (url: string) => void;
            attachMedia: (el: HTMLMediaElement) => void;
            destroy: () => void;
            on: (evt: string, cb: (...args: unknown[]) => void) => void;
          };
          Events: { ERROR: string };
        };
        if (!Hls.isSupported()) {
          setFailed(true);
          return;
        }
        const inst = new Hls({
          // The instant-clip manifest is short and we want it to play
          // immediately — keep buffers tight to cut startup latency.
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
          startLevel: 0,
          maxBufferSize: 8 * 1000 * 1000, // 8 MB
          maxStarvationDelay: 1,
          maxLoadingDelay: 1,
          backBufferLength: 4,
          // Source is VOD; no live tuning needed.
          lowLatencyMode: false,
          progressive: true,
        });
        inst.loadSource(streamUrl);
        inst.attachMedia(v);
        inst.on(Hls.Events.ERROR, (...args: unknown[]) => {
          // hls.js error payload: (event, data). data.fatal=true means
          // recovery isn't possible; fall back to the poster image.
          const data = args[1] as { fatal?: boolean } | undefined;
          if (data?.fatal) setFailed(true);
        });
        hlsRef.current = inst;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      teardownHls();
    };
  }, [streamUrl]);

  // Honor the autoplay prop dynamically. The Reels viewport flips this
  // when the active step changes — the new active reel goes autoplay
  // true, the previously-active reel (now ±1 prefetch) goes false. We
  // call play()/pause() explicitly because just toggling the attribute
  // doesn't affect a video that's already mounted.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (autoplay) {
      // Clear any user-paused state when this reel becomes active again
      // so the play() actually runs (and the tap-to-pause overlay below
      // shows the right icon next time the user taps).
      setUserPaused(false);
      setStarted(true);
      void v.play().catch(() => {
        // Browser refused autoplay (rare with muted=true). Show the
        // tap-to-play overlay so the user can start playback manually.
        setStarted(false);
      });
    } else {
      try {
        v.pause();
      } catch {
        // best-effort — element may have detached
      }
    }
  }, [autoplay]);

  // Track playback position for the loop-progress bar. `timeupdate`
  // fires ~4×/sec which is plenty for a visual indicator. The browser
  // resets `currentTime` to 0 on each loop wrap, so progress naturally
  // resets too — no manual reset needed.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function onTime() {
      const el = videoRef.current;
      if (!el || !isFinite(el.duration) || el.duration <= 0) {
        setProgress(0);
        return;
      }
      setProgress(Math.min(1, Math.max(0, el.currentTime / el.duration)));
    }
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onTime);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onTime);
    };
  }, []);

  // Always clear the flash timer on unmount; otherwise a fast unmount
  // mid-flash leaves a stale callback firing setState on a dead tree.
  useEffect(
    () => () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    },
    [],
  );

  function startPlayback() {
    const v = videoRef.current;
    if (!v) return;
    setStarted(true);
    void v.play().catch(() => {
      // Some browsers reject play() if the gesture didn't satisfy
      // policy. Native controls don't render here (we never show
      // them), so leave `started` true and let the user try again
      // with the visible play overlay.
    });
  }

  // Tap-anywhere toggle. Pauses when playing, resumes when paused, and
  // re-keys the flash overlay each time so successive taps each get a
  // fresh icon burst (Shorts-style).
  const togglePlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const nextPaused = !v.paused;
    if (nextPaused) {
      try {
        v.pause();
      } catch {
        // best-effort — element may have detached
      }
      setUserPaused(true);
    } else {
      void v.play().catch(() => {
        // Browser refused — leave the paused-overlay visible so the
        // tech can try again. Don't reset userPaused.
      });
      setUserPaused(false);
    }
    // Re-keying via incrementing nonce would also work; here we just
    // clear → set so the animation always restarts cleanly even on
    // rapid double-taps.
    setFlash(null);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    // requestAnimationFrame so the null→value transition flushes and
    // the CSS animation re-fires on consecutive taps within ~700ms.
    requestAnimationFrame(() => {
      setFlash(nextPaused ? 'pause' : 'play');
      flashTimerRef.current = setTimeout(() => setFlash(null), 700);
    });
  }, []);

  const containerStyle = {
    aspectRatio: frameAspectRatio(aspectRatio, orientation),
  } as React.CSSProperties;
  const isPortrait =
    orientation === 'portrait' ||
    (aspectRatio
      ? (() => {
          const m = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
          if (!m) return false;
          return Number(m[1]) < Number(m[2]);
        })()
      : false);
  const frameClassName = [
    'step-video-frame',
    isPortrait ? 'step-video-frame--portrait' : 'step-video-frame--landscape',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (failed && !posterUrl) {
    return (
      <div
        className={`${frameClassName} step-video-fallback`}
        role="img"
        aria-label={alt ?? caption ?? 'Video unavailable'}
        style={containerStyle}
      >
        <span aria-hidden>🎞️</span>
        <span>{caption ?? 'Video unavailable'}</span>
      </div>
    );
  }

  // When HLS failed but we have a poster, fall back to a static <img>.
  // Better than a black frame on a flaky network.
  if (failed && posterUrl) {
    return (
      <figure className={frameClassName} style={containerStyle}>
        <img
          src={posterUrl}
          alt={alt ?? caption ?? ''}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {caption && <figcaption className="step-video-caption">{caption}</figcaption>}
      </figure>
    );
  }

  return (
    <figure className={frameClassName} style={containerStyle}>
      <video
        ref={videoRef}
        poster={posterUrl}
        // Always muted regardless of caller preference. The step clip
        // is a silent demonstration loop — the AI voiceover plays from
        // a separate <audio> element in the runner. Native controls are
        // never shown (see `controls={false}` below), so there's no
        // path for the user to unmute and hear the original walkthrough
        // narration on top of the synthesized voiceover.
        muted
        playsInline
        autoPlay={autoplay}
        // Native loop on the trimmed manifest. The clip wraps cleanly
        // back to its own start because the manifest IS just the clip.
        loop
        disablePictureInPicture
        controlsList="nodownload noplaybackrate noremoteplayback"
        preload="auto"
        // NEVER render native HTML5 controls. They expose seek, mute,
        // and (on some browsers) PiP — and the mute toggle is the path
        // that would let a tech unmute and hear the original walkthrough
        // audio instead of the AI voiceover.
        controls={false}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        onError={() => setFailed(true)}
      />
      {/* Tap-to-play overlay only when autoplay didn't fire (rare —
          browser autoplay policies allow muted autoplay almost
          everywhere). Once playback starts we hide the overlay; we no
          longer show a fullscreen button. */}
      {!started && (
        <button
          type="button"
          className="step-video-overlay"
          onClick={startPlayback}
          aria-label={alt ?? 'Play clip'}
        >
          <span className="step-video-play-circle" aria-hidden>
            <Play size={28} strokeWidth={2.5} fill="currentColor" />
          </span>
        </button>
      )}
      {/* Tap-anywhere pause/resume — transparent overlay that captures
          taps on the active reel. The Reels viewport opts in; the
          classic stacked-card view does not. */}
      {tapToPause && started && (
        <button
          type="button"
          className="step-video-tap"
          onClick={togglePlayback}
          aria-label={userPaused ? 'Tap to resume' : 'Tap to pause'}
          aria-pressed={userPaused}
        />
      )}
      {/* Shorts-style flash icon. Renders only briefly (~700ms) after
          each toggle and is purely decorative — the underlying video
          is the source of truth for play/pause state. */}
      {flash && (
        <span className="step-video-flash" aria-hidden data-kind={flash}>
          {flash === 'pause' ? (
            <Pause size={36} strokeWidth={2.25} fill="currentColor" />
          ) : (
            <Play size={36} strokeWidth={2.25} fill="currentColor" />
          )}
        </span>
      )}
      {started && (
        <div className="step-video-progress" aria-hidden>
          <div
            className="step-video-progress-fill"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>
      )}
      {caption && started && (
        <figcaption className="step-video-caption">{caption}</figcaption>
      )}
    </figure>
  );
}
