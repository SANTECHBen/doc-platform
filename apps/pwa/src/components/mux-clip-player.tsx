'use client';

// MuxClipPlayer — renders a Mux HLS stream clamped to a [startMs, endMs]
// window and loops it on the step card. Produced by the AI walkthrough
// drafter: the drafter picks per-step clip ranges from the source video
// instead of cutting separate files, and this component plays the
// referenced range as if it were a baked clip.
//
// Playback strategy
// -----------------
// 1. Safari / iOS / iPadOS: HTMLMediaElement plays HLS natively (Mux's
//    .m3u8 URL is the src directly). No JS library needed.
// 2. Other browsers (Chrome / Firefox / Edge / Android Chrome): hls.js
//    is lazy-loaded on first render and attached via MediaSource
//    Extensions. The lazy import keeps the dep out of the initial PWA
//    bundle for HLS-native devices.
// 3. Range clamping is uniform across both paths: seek to startSec on
//    loadedmetadata, and a timeupdate listener seeks back to startSec
//    when currentTime crosses endSec. Native loop attribute is NOT used
//    because it loops the full asset; we loop the sub-range manually.
//
// Poster + fallback
// -----------------
// `posterUrl` is the storage-resolved keyframe JPEG (extracted by the
// drafter executor at proposal time). It paints before HLS loads and
// stays as the fallback if HLS fails on this device. If both the poster
// and the stream fail, we render a labeled placeholder so the tech sees
// something rather than a black frame.

import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';

interface Props {
  /** Mux HLS endpoint — typically https://stream.mux.com/<playbackId>.m3u8 */
  streamUrl: string;
  /** Inclusive clip start, milliseconds into the source video. */
  startMs: number;
  /** Exclusive clip end. Playback wraps back to startMs at this point. */
  endMs: number;
  /** Storage-resolved JPEG URL. Shown as poster and as fallback. */
  posterUrl?: string;
  alt?: string;
  caption?: string | null;
  /** Muted on mount. Required for autoplay on mobile per browser policy.
   *  Default true. */
  muted?: boolean;
  /** Autoplay + loop on mount. Default true — step clips behave like
   *  animated GIFs. Authors can opt out (e.g., on the doc viewer page
   *  where step cards stack and we don't want a dozen simultaneous
   *  videos) by passing false. */
  autoplay?: boolean;
  /** Identifier whose change triggers an auto-pause + reset. Pass the
   *  step id when one player exists per step. */
  playId: string;
  /** Source aspect ratio Mux reported ("16:9", "9:16", "4:3", "1:1"). When
   *  provided, the container frames the clip in matching aspect — portrait
   *  clips render in a tall frame instead of a letterboxed wide one. Falls
   *  back to landscape (16:9) when missing or unparseable. */
  aspectRatio?: string | null;
  /** Pre-classified orientation. Same data as aspectRatio but cheaper for
   *  the runner to consume (no parsing). Defaults to 'landscape'. */
  orientation?: 'portrait' | 'landscape' | 'square' | null;
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
  startMs,
  endMs,
  posterUrl,
  alt,
  caption,
  // muted is no longer read — the player force-mutes regardless,
  // because the original walkthrough audio should never play (only
  // the AI voiceover does, via a separate <audio> in the runner).
  // Leaving the prop in the type for API stability across callers.
  autoplay = true,
  playId,
  aspectRatio,
  orientation,
  className,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // hls.js instance — captured for cleanup. Null on Safari / before
  // first attach.
  const hlsRef = useRef<unknown>(null);
  const [started, setStarted] = useState(autoplay);
  const [failed, setFailed] = useState(false);
  // Progress within the [startMs..endMs] window, 0..1. Drives the thin
  // bottom bar so techs see where in the loop they are without unmuting
  // or scrubbing.
  const [progress, setProgress] = useState(0);

  const startSec = Math.max(0, startMs / 1000);
  const endSec = Math.max(startSec + 0.1, endMs / 1000);
  const spanSec = Math.max(0.1, endSec - startSec);

  // Attach the HLS source. On Safari / iOS we set src directly (native
  // HLS); elsewhere we dynamic-import hls.js and pipe MSE buffers in.
  // We re-attach when streamUrl changes (e.g., reviewer navigates between
  // drafts with different source videos).
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
          // Lower the live-edge tolerance and start delay for short
          // clips. We're not playing live content; default settings
          // are fine but tweaking these keeps the loop snappy.
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
          // Only load the first variant if there are multiple — short
          // clips don't need ABR ramp-up.
          startLevel: 0,
          // Aggressive startup tuning. The clip is short and we already
          // know we want it to play immediately; these knobs cut ~300-
          // 600ms off first-frame on Chrome by skipping speculative
          // higher-level probes and shrinking the parser window.
          maxBufferSize: 8 * 1000 * 1000, // 8 MB
          // Begin playback as soon as the first segment is buffered
          // rather than waiting for the default 3-second prebuffer.
          // We loop the same range, so initial buffer pressure is low.
          maxStarvationDelay: 1,
          maxLoadingDelay: 1,
          // Mux HLS chunks are short — load two ahead so the loop's
          // wrap-around doesn't stutter.
          backBufferLength: 4,
          // Snap startup to the requested clip start, avoiding the
          // double seek (play → seek → buffer) that adds latency.
          startPosition: Math.max(0, startMs / 1000),
          // Lower-latency loading even though this isn't a live stream;
          // gives faster first-frame because hls.js doesn't wait for a
          // full ABR cycle before declaring the stream "started."
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

  // Range clamp + autoplay arming. Re-runs when playId changes (e.g.,
  // the runner advances steps) or the window itself changes. We don't
  // use the native loop attribute because it loops the full asset, not
  // the sub-range — instead, a timeupdate listener resets currentTime
  // to startSec when it crosses endSec.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const seekToStart = () => {
      try {
        v.currentTime = startSec;
      } catch {
        // Some browsers throw if duration isn't known yet; the
        // loadedmetadata listener below catches that case.
      }
    };

    const onMeta = () => {
      seekToStart();
      if (autoplay) {
        setStarted(true);
        void v.play().catch(() => {
          // Autoplay policy refused (rare with muted=true). Show the
          // tap-to-play overlay instead of a frozen poster.
          setStarted(false);
        });
      }
    };

    const onTime = () => {
      if (!v) return;
      // Wrap when we cross endSec. A small epsilon (-0.05s) covers
      // browsers that fire timeupdate slightly past the boundary.
      if (v.currentTime >= endSec - 0.02) {
        try {
          v.currentTime = startSec;
        } catch {
          // ignore
        }
      }
      const elapsed = Math.max(0, v.currentTime - startSec);
      setProgress(Math.min(1, elapsed / spanSec));
    };

    // If metadata is already loaded (e.g., src didn't change but playId
    // did), seek immediately. Otherwise wait for loadedmetadata.
    if (v.readyState >= 1) {
      onMeta();
    }
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
    };
  }, [playId, startSec, endSec, spanSec, autoplay]);

  // Reset visible progress + playback position when the step changes.
  // Kept separate from the HLS attach effect so it runs even when
  // streamUrl is stable across step navigations (a single source video
  // backs every step of an AI-drafted procedure).
  useEffect(() => {
    setProgress(0);
    setStarted(autoplay);
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
        // Always muted regardless of the caller's `muted` prop. The
        // step clip is a silent demonstration loop — the AI voiceover
        // plays from a separate <audio> element in the runner. If the
        // native controls ever rendered (they shouldn't now, see
        // below), unmuting them would surface the raw walkthrough
        // narration on top of the synthesized voiceover.
        muted
        playsInline
        autoPlay={autoplay}
        // Native loop is OFF — we loop the sub-range manually via
        // timeupdate so the wrap point matches endMs, not the full
        // asset duration.
        loop={false}
        // Disable Picture-in-Picture and download/share affordances
        // some browsers expose without controls. The clip is part of
        // a procedure, not a standalone video.
        disablePictureInPicture
        controlsList="nodownload noplaybackrate noremoteplayback"
        // Always 'auto' so the browser begins fetching the manifest +
        // first segment as soon as the element mounts.
        preload="auto"
        // NEVER render the native HTML5 controls. They expose seek,
        // mute, and (on some browsers) PiP — and the mute toggle is
        // the path that would let a tech unmute and hear the original
        // walkthrough audio instead of the AI voiceover. The clip is
        // an autoplay-loop demonstration; no user-facing controls.
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
