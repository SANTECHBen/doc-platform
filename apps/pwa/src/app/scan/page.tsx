'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { Flashlight, FlashlightOff } from 'lucide-react';

// Torch capability detection types — the MediaStream torch API is not in
// standard TS lib.dom.d.ts yet, but it's supported on Chrome Android
// and (more inconsistently) on iOS Safari. We narrow ad-hoc.
interface TorchCapableTrack extends MediaStreamTrack {
  getCapabilities(): MediaTrackCapabilities & { torch?: boolean };
  applyConstraints(constraints: MediaTrackConstraints & {
    advanced?: Array<{ torch?: boolean }>;
  }): Promise<void>;
}

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const trackRef = useRef<TorchCapableTrack | null>(null);
  const router = useRouter();

  useEffect(() => {
    const reader = new BrowserQRCodeReader();
    let controls: IScannerControls | undefined;
    let cancelled = false;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;

    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    function showTransientError(message: string) {
      setError(message);
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => setError(null), 4000);
    }

    reader
      .decodeFromVideoDevice(undefined, videoRef.current!, (result, _err, scannerControls) => {
        if (cancelled) return;
        controls = scannerControls;
        if (!result) return;
        const text = result.getText();
        const code = extractQrCode(text);
        if (!code) {
          showTransientError('Unrecognized QR format. Try again.');
          return;
        }
        scannerControls.stop();
        router.replace(`/q/${code}`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    // After the reader starts, the video element's srcObject is the live
    // MediaStream. Probe it for the torch capability. We give it a tick
    // so the stream is settled — getCapabilities() returns an empty
    // object before the first frame is available on some devices.
    probeTimer = setTimeout(() => {
      if (cancelled) return;
      const stream = videoRef.current?.srcObject;
      if (!(stream instanceof MediaStream)) return;
      const [track] = stream.getVideoTracks();
      if (!track) return;
      const torchTrack = track as TorchCapableTrack;
      const caps = torchTrack.getCapabilities?.();
      if (caps && 'torch' in caps && caps.torch === true) {
        trackRef.current = torchTrack;
        setTorchSupported(true);
      }
    }, 500);

    return () => {
      cancelled = true;
      if (errorTimer) clearTimeout(errorTimer);
      if (probeTimer) clearTimeout(probeTimer);
      // Always release the torch on unmount — leaving it on after
      // navigating away would burn battery and surprise the tech.
      const track = trackRef.current;
      if (track) {
        try {
          void track.applyConstraints({ advanced: [{ torch: false }] });
        } catch {
          /* track may already be stopped — fine */
        }
        trackRef.current = null;
      }
      controls?.stop();
    };
  }, [router]);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not toggle torch');
    }
  }

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-4 focus:outline-none">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-sm text-ink-secondary hover:text-ink-primary">
          ← Back
        </Link>
        <div className="flex items-center gap-2">
          <span className="led led-ok" />
          <span className="caption">Scanning</span>
        </div>
      </header>

      <div className="relative overflow-hidden rounded-lg border border-line bg-surface-inset">
        <video
          ref={videoRef}
          className="aspect-[3/4] w-full object-cover md:aspect-video"
          muted
          playsInline
        />
        {/* Corner guides */}
        <div className="pointer-events-none absolute inset-6 flex items-stretch justify-stretch">
          <div className="relative flex-1">
            <span className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2 border-brand" />
            <span className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2 border-brand" />
            <span className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2 border-brand" />
            <span className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2 border-brand" />
          </div>
        </div>

        {/* Torch toggle — only rendered when the device's camera reports
            the torch capability. Bottom-center floating button so it's
            within thumb reach without occluding the QR target frame. */}
        {torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            className="scan-torch-btn"
            data-on={torchOn ? 'true' : 'false'}
            aria-label={torchOn ? 'Turn flashlight off' : 'Turn flashlight on'}
            aria-pressed={torchOn}
          >
            {torchOn ? (
              <Flashlight size={20} strokeWidth={2} />
            ) : (
              <FlashlightOff size={20} strokeWidth={2} />
            )}
          </button>
        )}
      </div>

      <p className="text-center text-sm text-ink-secondary">
        Align the QR code inside the frame. Steady the phone — no button needed.
      </p>

      {error && (
        <div className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </div>
      )}
    </main>
  );
}

function extractQrCode(raw: string): string | null {
  const trimmed = raw.trim();
  const urlMatch = trimmed.match(/\/q\/([A-Z0-9]{8,24})/i);
  if (urlMatch && urlMatch[1]) return urlMatch[1].toUpperCase();
  const bareMatch = trimmed.match(/^([A-Z0-9]{8,24})$/i);
  if (bareMatch && bareMatch[1]) return bareMatch[1].toUpperCase();
  return null;
}
