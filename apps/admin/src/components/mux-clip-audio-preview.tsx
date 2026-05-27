'use client';

// MuxClipAudioPreview — the admin reviewer's "scrub the cut" player.
//
// Per-step clip preview for the procedure-drafts review page and the
// post-publish clip-range editor. The reviewer needs to hear when
// narration starts and ends — that's the signal they trim against —
// so this player:
//
//   * A play button that swaps the GIF for a real HLS player.
//   * Audio enabled — the original captured walkthrough narration plays
//     so the reviewer can hear where the next step begins.
//   * Native controls: scrub, play/pause, volume. The reviewer
//     intentionally has the same affordances they'd have in a desktop
//     video player.
//   * Looped playback constrained to [startMs..endMs] — the URL is a
//     Mux instant-clip manifest, so `loop` is a free attribute.
//   * Auto-rebuild when start/end change. Trimming the inputs above the
//     player should immediately reflect in what plays back.
//
// Playback strategy mirrors the PWA's MuxClipPlayer: Safari plays the
// .m3u8 natively; other browsers lazy-import hls.js and pipe MSE in.
// hls.js stays out of the initial admin bundle for HLS-native devices.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { getMuxClipUrl } from '@/lib/api';

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

// Same lazy-load pattern as MuxClipPlayer in the PWA. hls.js stays out
// of the initial bundle until the first non-Safari player mounts.
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
  // Activated only on play tap. Until then we render a still poster so
  // a procedure with 30 steps doesn't fire 30 simultaneous HLS attaches.
  const [active, setActive] = useState(false);
  // Loading the clip URL or the HLS handshake.
  const [loading, setLoading] = useState(false);
  // Resolved clip URL — kept in state so we can show a friendly error if
  // the mint call fails.
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poster from Mux's image API — works on every playback id without
  // asset-config changes. We pick the midpoint of the trimmed range so
  // the still is representative of the action.
  const midSec = Math.max(0, Math.floor((startMs + endMs) / 2000));
  const posterUrl = `https://image.mux.com/${playbackId}/thumbnail.jpg?time=${midSec}&width=480`;

  // Mint a clip URL whenever the bounds change AND the player is active.
  // The URL embeds the bounds (and a JWT on signed-playback deployments),
  // so a trim of the start/end fields invalidates the previous URL.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStreamUrl(null);
    void getMuxClipUrl({ playbackId, startMs, endMs })
      .then((r) => {
        if (cancelled) return;
        setStreamUrl(r.url);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, playbackId, startMs, endMs]);

  // Attach the resolved URL via native HLS (Safari) or hls.js (others).
  // We mirror the PWA's MuxClipPlayer attach logic — tighter buffer
  // settings keep startup latency low on the short instant-clip
  // manifests Mux returns for our trimmed ranges.
  useEffect(() => {
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

    if (canNative) {
      v.src = streamUrl;
      setLoading(false);
      return () => {
        cancelled = true;
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
          Events: { ERROR: string };
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
      teardown();
    };
  }, [streamUrl]);

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
            poster={posterUrl}
            playsInline
            autoPlay
            loop
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
          <img
            src={posterUrl}
            alt="Clip preview"
            className="h-full w-full object-cover"
          />
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
