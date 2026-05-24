'use client';

// InAppCamera — full-screen camera/recorder that bypasses the device's
// native camera app. Pins resolution + bitrate so the produced file is
// upload-friendly (5 Mbps @ 1080p ≈ 38 MB/min instead of the iPhone 16
// Pro's default 8K HEVC ~580 MB/min).
//
// Why bypass the native picker?
//   - <input capture="environment"> hands off to the device camera, which
//     records at whatever resolution/codec the user has configured in
//     system settings. iOS Pro Max defaults to 4K/60 HEVC; some Androids
//     default to 8K. A 35-second walkthrough then becomes a 300+ MB
//     upload — unworkable on field cellular.
//   - getUserMedia + MediaRecorder lets us pin track constraints to
//     1080p (1920×1080 / 1080×1920) and the MediaRecorder bitrate to
//     5 Mbps. Same model TikTok / Instagram / every social camera uses.
//
// Output: a single File the parent's onCapture receives. Container is
// MP4 (H.264 + AAC) on iOS Safari, WebM (VP9 + Opus) elsewhere. Mux
// accepts both.

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  RotateCcw,
  Square,
  Video,
  X,
} from 'lucide-react';

interface Props {
  onCapture: (file: File) => void;
  onClose: () => void;
}

type Phase =
  | { kind: 'initializing' }
  | { kind: 'ready' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

// MediaRecorder mimeType candidates, ordered from "ideal for Mux" to
// "any modern container Mux can ingest." We probe at runtime because
// support varies: iOS Safari 14.5+ does mp4/h264, Chrome does webm/vp9,
// Firefox does webm/vp8.
const MIME_CANDIDATES: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
  { mime: 'video/mp4;codecs=h264,aac', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1,mp4a', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

function pickMimeType(): { mime: string; ext: 'mp4' | 'webm' } {
  if (typeof MediaRecorder === 'undefined') {
    return { mime: '', ext: 'webm' };
  }
  for (const c of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      // Older Safari throws on isTypeSupported with codec params;
      // fall through.
    }
  }
  return { mime: '', ext: 'webm' };
}

export function InAppCamera({ onCapture, onClose }: Props): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Canvas-rotation pipeline state. iOS Safari (and most browsers) hand
  // back a landscape MediaStream regardless of how the phone is held —
  // the <video> preview rotates correctly because WebKit honors the
  // device orientation tag for display, but the underlying frames the
  // MediaRecorder sees are still landscape. If we just record that
  // stream, Mux ingests it as 16:9.
  //
  // To produce upright portrait frames when the user wants portrait,
  // we draw the camera's video element onto a canvas at the desired
  // orientation (rotating 90° if needed) and feed canvas.captureStream
  // into the MediaRecorder instead of the raw camera stream. The audio
  // track is mixed in from the original stream.
  const rotationRafRef = useRef<number | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const composedStreamRef = useRef<MediaStream | null>(null);

  const [facingMode, setFacingMode] = useState<'environment' | 'user'>(
    'environment',
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'initializing' });
  const [elapsedMs, setElapsedMs] = useState(0);

  // Track viewport orientation so we can request a matching camera
  // track. When the phone is in portrait, we ask for 1080×1920 (tall);
  // landscape gets 1920×1080 (wide). Without this, getUserMedia hands
  // back a landscape 1920×1080 track even on a phone held vertically,
  // producing a sideways recording that Mux dutifully publishes as
  // landscape.
  const [isPortrait, setIsPortrait] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      return window.matchMedia('(orientation: portrait)').matches;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(orientation: portrait)');
    const update = (e: MediaQueryListEvent | MediaQueryList) =>
      setIsPortrait('matches' in e ? e.matches : mq.matches);
    update(mq);
    if ('addEventListener' in mq) {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    // Safari < 14 fallback — old MediaQueryList API.
    const legacy = mq as MediaQueryList & {
      addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
      removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
    };
    legacy.addListener?.(update);
    return () => legacy.removeListener?.(update);
  }, []);

  // Acquire (or re-acquire) the camera stream whenever facingMode changes.
  // We stop the prior stream first so a flip-camera doesn't leave the
  // old track running.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'initializing' });

    async function start() {
      // Tear down any previous stream before requesting a new one.
      const prior = streamRef.current;
      if (prior) {
        prior.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      try {
        // Don't pin width/height — iOS Safari ignores portrait
        // constraints anyway and hands back a 1920×1080 landscape track
        // even on a phone held vertically. We let the camera give its
        // natural orientation (almost always landscape on phones) and
        // do the rotation ourselves via canvas at record time. The
        // long-edge cap stays at 1920 so we don't pull 4K/8K frames
        // through the canvas pipeline.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1920 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.muted = true; // required for autoplay on iOS
          await v.play().catch(() => {
            // Some browsers reject play() until user gestures; the user
            // can still tap the record button which triggers playback.
          });
        }
        setPhase({ kind: 'ready' });
      } catch (err) {
        if (cancelled) return;
        if (
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'SecurityError')
        ) {
          setPhase({ kind: 'denied' });
        } else {
          setPhase({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [facingMode]);

  // Tear down everything on unmount — including any in-flight recorder
  // so we don't leak a chunk buffer or hold the camera/mic open.
  useEffect(() => {
    return () => {
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
      if (rotationRafRef.current !== null) {
        cancelAnimationFrame(rotationRafRef.current);
        rotationRafRef.current = null;
      }
      const composed = composedStreamRef.current;
      if (composed) composed.getTracks().forEach((t) => t.stop());
      composedStreamRef.current = null;
      offscreenCanvasRef.current = null;
      const s = streamRef.current;
      if (s) s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  // Tick the timer while recording. Re-creates the interval each time
  // we transition into recording so the start anchor is fresh.
  useEffect(() => {
    if (phase.kind !== 'recording') {
      setElapsedMs(0);
      return;
    }
    const started = phase.startedAt;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - started);
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  function startRecording() {
    const stream = streamRef.current;
    const previewEl = videoRef.current;
    if (!stream || !previewEl) return;
    const { mime, ext } = pickMimeType();
    chunksRef.current = [];

    const options: MediaRecorderOptions = {
      // 5 Mbps video keeps a 30-second 1080p clip under ~20 MB while
      // still looking clean on the procedure runner. 128 kbps audio is
      // overkill for narration but transcodes cleanly through Mux's
      // ingest pipeline.
      videoBitsPerSecond: 5_000_000,
      audioBitsPerSecond: 128_000,
    };
    if (mime) options.mimeType = mime;

    // Decide whether to route through the canvas-rotation pipeline.
    // The camera track is almost always landscape on phones (the
    // sensor's physical orientation); when the user is filming with
    // the phone held in portrait, we have to rotate the frames
    // ourselves so the recorded file has upright portrait pixels.
    // The <video> preview already shows the rotated view because
    // WebKit/Chromium honor the device orientation tag for display
    // — but MediaRecorder reads the raw track, so the file would be
    // sideways without this rotation pass.
    const videoTrack = stream.getVideoTracks()[0];
    const trackSettings = videoTrack?.getSettings() ?? {};
    const srcW = trackSettings.width ?? previewEl.videoWidth ?? 1920;
    const srcH = trackSettings.height ?? previewEl.videoHeight ?? 1080;
    const sourceIsLandscape = srcW >= srcH;
    const needsRotation =
      (isPortrait && sourceIsLandscape) || (!isPortrait && !sourceIsLandscape);

    // The stream we hand to MediaRecorder. Either the raw camera
    // stream, or a composed canvas + original-audio stream when we're
    // doing rotation.
    let recordStream: MediaStream = stream;

    if (needsRotation) {
      const outW = Math.min(srcW, srcH); // short edge → output width
      const outH = Math.max(srcW, srcH); // long edge → output height
      const canvas = document.createElement('canvas');
      canvas.width = isPortrait ? outW : outH;
      canvas.height = isPortrait ? outH : outW;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setPhase({ kind: 'error', message: '2D canvas unavailable' });
        return;
      }
      offscreenCanvasRef.current = canvas;

      // 90° clockwise rotation for a phone held in portrait with the
      // camera in landscape orientation. We translate to the canvas
      // center, rotate, then draw the source frame offset so the
      // origin lands at (-srcW/2, -srcH/2).
      const angle = isPortrait ? Math.PI / 2 : -Math.PI / 2;
      const drawFrame = () => {
        if (
          previewEl.readyState >= 2 &&
          previewEl.videoWidth > 0 &&
          previewEl.videoHeight > 0
        ) {
          ctx.save();
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate(angle);
          ctx.drawImage(previewEl, -srcW / 2, -srcH / 2, srcW, srcH);
          ctx.restore();
        }
        rotationRafRef.current = requestAnimationFrame(drawFrame);
      };
      rotationRafRef.current = requestAnimationFrame(drawFrame);

      const canvasStream = (canvas as HTMLCanvasElement & {
        captureStream: (frameRate?: number) => MediaStream;
      }).captureStream(30);
      // Carry the original audio track through so we still record the
      // tech's narration. canvas.captureStream() doesn't include audio.
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) canvasStream.addTrack(audioTrack);
      composedStreamRef.current = canvasStream;
      recordStream = canvasStream;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(recordStream, options);
    } catch (err) {
      // Some Androids reject the explicit mimeType — retry without it.
      try {
        recorder = new MediaRecorder(recordStream, {
          videoBitsPerSecond: 5_000_000,
          audioBitsPerSecond: 128_000,
        });
      } catch (err2) {
        // Tear down the rotation pipeline if we set one up.
        if (rotationRafRef.current !== null) {
          cancelAnimationFrame(rotationRafRef.current);
          rotationRafRef.current = null;
        }
        composedStreamRef.current?.getTracks().forEach((t) => t.stop());
        composedStreamRef.current = null;
        offscreenCanvasRef.current = null;
        setPhase({
          kind: 'error',
          message:
            err2 instanceof Error ? err2.message : 'MediaRecorder unavailable',
        });
        return;
      }
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      // Tear down the rotation pipeline now that the recording's done.
      // Leaving the RAF + composed stream running would burn battery
      // and keep the camera frame-pump going for nothing.
      if (rotationRafRef.current !== null) {
        cancelAnimationFrame(rotationRafRef.current);
        rotationRafRef.current = null;
      }
      composedStreamRef.current?.getTracks().forEach((t) => {
        // Only stop the canvas-emitted video track; the audio track
        // belongs to the original camera stream and gets stopped on
        // unmount when the parent calls onCapture/onClose.
        if (t.kind === 'video') t.stop();
      });
      composedStreamRef.current = null;
      offscreenCanvasRef.current = null;

      const blobType = mime || chunksRef.current[0]?.type || 'video/webm';
      const blob = new Blob(chunksRef.current, { type: blobType });
      // 0-byte recording — happens if the user taps stop too fast,
      // before ondataavailable fires. Treat as a no-op and let them
      // try again.
      if (blob.size === 0) {
        setPhase({ kind: 'ready' });
        return;
      }
      const file = new File(
        [blob],
        `walkthrough-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
        { type: blobType, lastModified: Date.now() },
      );
      onCapture(file);
    };

    recorder.onerror = (e) => {
      setPhase({
        kind: 'error',
        message:
          e instanceof Error
            ? e.message
            : 'recorder error — try Pick from gallery',
      });
    };

    // 1-second chunk cadence so we never lose more than a second of
    // footage if the browser kills the tab mid-record.
    recorder.start(1_000);
    setPhase({ kind: 'recording', startedAt: Date.now() });
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // ignore — onstop will not fire but the user can retry
      }
    }
  }

  function flipCamera() {
    if (phase.kind === 'recording') return;
    setFacingMode((m) => (m === 'environment' ? 'user' : 'environment'));
  }

  const recording = phase.kind === 'recording';
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const timerLabel = `${Math.floor(elapsedSec / 60)
    .toString()
    .padStart(2, '0')}:${(elapsedSec % 60).toString().padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      {/* Live preview — fills the screen behind the controls. We rely on
          the <video> object-fit to honor the stream's native aspect, so
          portrait phone footage gets a portrait viewfinder and landscape
          tablets get landscape. */}
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        // user-facing camera previews mirrored, like every selfie app.
        // Recording is NOT mirrored — the recorded file matches what
        // the lens actually saw.
        className={
          'absolute inset-0 h-full w-full object-cover ' +
          (facingMode === 'user' ? 'scale-x-[-1]' : '')
        }
      />

      {/* Top bar — close + flip-camera + recording indicator. */}
      <header className="relative z-10 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
        <button
          type="button"
          onClick={() => {
            if (recording) {
              stopRecording();
              return;
            }
            onClose();
          }}
          aria-label={recording ? 'Stop and discard' : 'Close camera'}
          className="grid h-9 w-9 place-items-center rounded-full bg-black/45 backdrop-blur transition active:scale-95"
        >
          {recording ? <X size={18} /> : <ArrowLeft size={18} />}
        </button>

        {recording && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/95 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider shadow-md">
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            REC {timerLabel}
          </span>
        )}

        <button
          type="button"
          onClick={flipCamera}
          disabled={recording || phase.kind === 'initializing'}
          aria-label="Switch camera"
          className="grid h-9 w-9 place-items-center rounded-full bg-black/45 backdrop-blur transition active:scale-95 disabled:opacity-30"
        >
          <RotateCcw size={16} />
        </button>
      </header>

      {/* Center overlays — only when we don't have a usable preview. */}
      {(phase.kind === 'initializing' ||
        phase.kind === 'denied' ||
        phase.kind === 'error') && (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
          {phase.kind === 'initializing' && (
            <div className="flex flex-col items-center gap-3 text-center">
              <Video size={36} className="animate-pulse text-white/80" />
              <p className="text-sm text-white/80">Starting camera…</p>
            </div>
          )}
          {phase.kind === 'denied' && (
            <div className="max-w-xs space-y-3 rounded-2xl border border-white/15 bg-black/70 p-5 text-center backdrop-blur">
              <AlertTriangle
                size={28}
                className="mx-auto text-amber-300"
                strokeWidth={1.5}
              />
              <p className="text-base font-semibold">Camera access blocked</p>
              <p className="text-xs leading-relaxed text-white/70">
                Enable camera + microphone for this site in your browser
                settings, then return here and try again. On iOS:
                Settings → Safari → Camera/Microphone → Allow.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-white/20 px-3 py-2 text-xs font-semibold hover:bg-white/10"
              >
                Close
              </button>
            </div>
          )}
          {phase.kind === 'error' && (
            <div className="max-w-xs space-y-3 rounded-2xl border border-red-400/30 bg-black/75 p-5 text-center backdrop-blur">
              <AlertTriangle
                size={28}
                className="mx-auto text-red-300"
                strokeWidth={1.5}
              />
              <p className="text-base font-semibold">Camera unavailable</p>
              <p className="text-xs leading-relaxed text-white/70">
                {phase.message}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-white/20 px-3 py-2 text-xs font-semibold hover:bg-white/10"
              >
                Close
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bottom controls — large record/stop button. Stays out of the
          way during preview; becomes the only thing on screen during
          a recording so the tech doesn't fumble. */}
      <footer className="relative z-10 mt-auto flex flex-col items-center gap-3 bg-gradient-to-t from-black/75 via-black/40 to-transparent px-6 pb-8 pt-10">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">
          {recording
            ? 'Narrate each step as you film'
            : phase.kind === 'ready'
              ? '1080p · 5 Mbps · tap to start'
              : ''}
        </p>
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={phase.kind !== 'ready' && phase.kind !== 'recording'}
          aria-label={recording ? 'Stop recording' : 'Start recording'}
          className="grid h-20 w-20 place-items-center rounded-full bg-white/15 ring-4 ring-white/80 transition active:scale-95 disabled:opacity-40"
        >
          {recording ? (
            <span className="grid h-9 w-9 place-items-center rounded-md bg-red-600">
              <Square size={18} strokeWidth={2.5} fill="currentColor" />
            </span>
          ) : (
            <span className="h-14 w-14 rounded-full bg-red-600 shadow-lg" />
          )}
        </button>
        {!recording && phase.kind === 'ready' && (
          <p className="max-w-xs text-center text-[11px] leading-relaxed text-white/55">
            Hold the phone steady. The recorded clip matches what you see
            here — no 8K, no oversized files.
          </p>
        )}
      </footer>
    </div>
  );
}
