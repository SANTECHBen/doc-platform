'use client';

// MuxClipAudioPreview — the admin reviewer's "scrub the cut" player.
//
// Plays a per-step clip with audio so the reviewer can hear where
// narration starts and ends — that's the signal they trim against.
//
// Playback strategy: stream the FULL source asset's HLS manifest and
// clamp playback to [startMs..endMs] via `currentTime` rather than
// asking Mux's instant-clipping edge for a trimmed manifest. The
// instant-clip edge aligns to HLS segments (2s with our upload
// settings; ~6s on legacy assets), so a 2s ask can return 4–6s of
// actual playback. Source + client-side clamping gives frame-accurate
// trim preview at the cost of a marginally heavier manifest fetch.
//
// Wrap behavior: on each timeupdate, if currentTime is past endMs we
// seek back to startMs. The browser's native `loop` attribute would
// loop the entire source manifest, which is the wrong window — so
// we manage looping ourselves. Wrap latency is bounded by how often
// timeupdate fires (~4×/s in browsers), which is plenty tight for an
// authoring auditioning tool.
//
// Strategy across browsers:
//   * Safari / iOS: native HLS — `<video src>` accepts an .m3u8.
//   * Chrome / Firefox / Edge: lazy-import hls.js and attach via MSE.
//     The dep stays out of the initial admin bundle until the first
//     preview mounts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { getMuxPlaybackAccess } from '@/lib/api';

interface Props {
  playbackId: string;
  startMs: number;
  endMs: number;
  /** Aspect ratio reported by Mux (e.g. "16:9", "9:16"). Drives the
   *  container shape so a portrait clip doesn't letterbox in a wide box. */
  aspectRatio?: string | null;
  /** Pre-classified orientation. Same data as aspectRatio but cheaper to
   *  consume. Defaults to 'landscape'. */
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

// Lazy-load hls.js. Identical pattern to the PWA's MuxClipPlayer — the
// dep is heavy enough that we don't want it in the initial bundle for
// admins on a Safari-equivalent (Mac admins are common in this product).
let hlsModulePromise: Promise<unknown> | null = null;
function loadHlsModule(): Promise<unknown> {
  if (!hlsModulePromise) {
    hlsModulePromise = import('hls.js').then((m) => {
      const mod = m as { default?: unknown };
      return mod.default ?? m;
    });
  }
  return hlsModulePromise;
}

export function MuxClipAudioPreview({
  playbackId,
  startMs,
  endMs,
  aspectRatio,
  orientation,
}: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<unknown>(null);
  // Activated only on play tap. Keeps a procedure with 30 steps from
  // mounting 30 HLS instances on first render — each is shown as a
  // poster until the reviewer asks for playback.
  const [active, setActive] = useState(false);
  // Loading covers the URL mint AND the initial HLS handshake; cleared
  // once the manifest is attached.
  const [loading, setLoading] = useState(false);
  // Resolved source-asset URL. Stays stable across clip-range changes
  // (the bounds clamp playback locally; only the playback id triggers
  // a re-mint).
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  // Poster URL builder — set alongside streamUrl so the thumbnail also
  // carries the right signed token on signed-playback deployments.
  // Unsigned deployments still get an unsigned URL from the same helper.
  const [posterUrlFor, setPosterUrlFor] = useState<
    ((timeSec: number, widthPx?: number) => string) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  // Keep the latest bounds available to the timeupdate handler without
  // re-binding the listener on every drag. The handler reads the refs
  // synchronously each tick, so live slider drags reflect immediately.
  const startMsRef = useRef(startMs);
  const endMsRef = useRef(endMs);
  useEffect(() => {
    startMsRef.current = startMs;
    endMsRef.current = endMs;
    // When the bounds change while playing, snap playback back into
    // the new window if currentTime drifted outside.
    const v = videoRef.current;
    if (!v || v.readyState < 1) return;
    const currentMs = v.currentTime * 1000;
    if (currentMs < startMs - 100 || currentMs >= endMs) {
      try {
        v.currentTime = startMs / 1000;
      } catch {
        // Ignore — element may not be ready for a seek yet.
      }
    }
  }, [startMs, endMs]);

  // Mux's image.mux.com endpoints need their own audience-scoped token
  // on signed-playback deployments. Mint both the source and the
  // thumbnail tokens up front when the player goes active; reuse the
  // posterUrlFor builder for every recomputation of the poster as the
  // user trims (midpoint changes with the bounds).
  const midSec = Math.max(0, Math.floor((startMs + endMs) / 2000));
  const posterUrl = useMemo(
    () => (posterUrlFor ? posterUrlFor(midSec, 480) : null),
    [posterUrlFor, midSec],
  );

  // Fetch playback access (source URL + poster URL builder) on mount,
  // not on activate. Reasons:
  //   * The poster needs to render in the inactive state so the
  //     reviewer sees the clip's keyframe before clicking play.
  //   * Mux's image.mux.com endpoints 404 without a signed token on
  //     signed-playback deployments; the unsigned URL we used to build
  //     locally was the immediate cause of the broken thumbnails.
  //   * Cost is two small token-mint calls per playback id; we don't
  //     attach HLS until activate, so the 30-step procedure case still
  //     only spins up one player.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void getMuxPlaybackAccess(playbackId)
      .then((r) => {
        if (cancelled) return;
        setStreamUrl(r.sourceUrl);
        setPosterUrlFor(() => r.posterUrlFor);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [playbackId]);

  // Toggle the spinner only while the player is active AND we haven't
  // resolved a URL yet — the inactive poster state is fine without one.
  useEffect(() => {
    if (active && !streamUrl) {
      setLoading(true);
    } else if (streamUrl) {
      // Cleared by the attach effect once HLS is bound; resetting here
      // covers the rare case of bouncing active→inactive→active.
      setLoading(false);
    }
  }, [active, streamUrl]);

  // Attach the source URL via native HLS (Safari) or hls.js (others).
  // Depends on both `active` and `streamUrl` because the <video>
  // element only exists in the active state — without the active dep,
  // the effect would run once when the token fetch resolves (while
  // active is still false and videoRef.current is null), bail out, and
  // never re-fire when the user clicks play.
  useEffect(() => {
    if (!active) return;
    const v = videoRef.current;
    if (!v || !streamUrl) return;
    let cancelled = false;

    const teardown = () => {
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

    const canNative =
      v.canPlayType('application/vnd.apple.mpegurl') !== '' ||
      v.canPlayType('application/vnd.apple.mpegURL') !== '';

    function seekToStart() {
      const cur = videoRef.current;
      if (!cur) return;
      try {
        cur.currentTime = startMsRef.current / 1000;
      } catch {
        // ignore — pre-load seeks fail silently on some browsers
      }
    }
    v.addEventListener('loadedmetadata', seekToStart);

    if (canNative) {
      v.src = streamUrl;
      setLoading(false);
      return () => {
        cancelled = true;
        v.removeEventListener('loadedmetadata', seekToStart);
        teardown();
        try {
          v.removeAttribute('src');
          v.load();
        } catch {
          // element may already be detached
        }
      };
    }

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
          Events: { ERROR: string; MANIFEST_PARSED: string };
        };
        if (!Hls.isSupported()) {
          setError('Your browser does not support clip preview playback.');
          setLoading(false);
          return;
        }
        const inst = new Hls({
          maxBufferLength: 8,
          maxMaxBufferLength: 16,
          startLevel: 0,
          maxBufferSize: 8 * 1000 * 1000,
          maxStarvationDelay: 1,
          maxLoadingDelay: 1,
          backBufferLength: 4,
          lowLatencyMode: false,
          progressive: true,
        });
        inst.loadSource(streamUrl);
        inst.attachMedia(v);
        inst.on(Hls.Events.MANIFEST_PARSED, () => {
          // Seek to clip start as soon as we have a parsed manifest —
          // before MEDIA_ATTACHED finishes painting the first frame —
          // so the user sees the right opening still, not the source's
          // first frame.
          seekToStart();
        });
        inst.on(Hls.Events.ERROR, (...args: unknown[]) => {
          const data = args[1] as { fatal?: boolean } | undefined;
          if (data?.fatal) {
            setError('Clip playback failed.');
          }
        });
        hlsRef.current = inst;
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load video player.');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      v.removeEventListener('loadedmetadata', seekToStart);
      teardown();
    };
  }, [active, streamUrl]);

  // Clamp playback to [startMs..endMs]. The native `loop` attribute
  // would loop the entire source asset, which is the wrong window, so
  // we install our own timeupdate wrap. Ref-reading lets a live slider
  // drag take effect on the very next tick without re-attaching the
  // listener.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    function onTime() {
      const el = videoRef.current;
      if (!el) return;
      const currentMs = el.currentTime * 1000;
      if (currentMs >= endMsRef.current) {
        try {
          el.currentTime = startMsRef.current / 1000;
        } catch {
          // best-effort
        }
      } else if (currentMs < startMsRef.current - 100) {
        // Native scrub or HLS seek slightly undershot the start — pull
        // forward to the requested boundary.
        try {
          el.currentTime = startMsRef.current / 1000;
        } catch {
          // best-effort
        }
      }
    }
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, []);

  const activate = useCallback(() => {
    setActive(true);
  }, []);

  const isPortrait =
    orientation === 'portrait' ||
    (aspectRatio
      ? (() => {
          const m = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
          if (!m) return false;
          return Number(m[1]) < Number(m[2]);
        })()
      : false);

  const containerStyle: React.CSSProperties = {
    aspectRatio: frameAspectRatio(aspectRatio, orientation),
    ...(isPortrait ? { maxWidth: '180px', marginInline: 'auto' } : {}),
  };

  return (
    <div
      className="relative overflow-hidden rounded-md border border-line bg-black"
      style={containerStyle}
    >
      {active ? (
        <>
          <video
            ref={videoRef}
            poster={posterUrl ?? undefined}
            playsInline
            autoPlay
            controls
            controlsList="nodownload noplaybackrate noremoteplayback"
            disablePictureInPicture
            preload="auto"
            className="h-full w-full object-contain"
          />
          {loading && (
            <div className="absolute inset-0 grid place-items-center bg-black/40">
              <Loader2 className="size-6 animate-spin text-white" />
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 grid place-items-center bg-black/70 px-3 text-center text-[11px] text-white/80">
              {error}
            </div>
          )}
        </>
      ) : (
        <>
          {posterUrl ? (
            <img
              src={posterUrl}
              alt="Clip preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-white/40">
              {error ? (
                <span className="px-3 text-center text-[11px]">{error}</span>
              ) : (
                <Loader2 className="size-6 animate-spin" />
              )}
            </div>
          )}
          <button
            type="button"
            onClick={activate}
            aria-label="Play clip with audio"
            className="absolute inset-0 grid place-items-center bg-black/20 transition hover:bg-black/40"
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
