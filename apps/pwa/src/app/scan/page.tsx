'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const reader = new BrowserQRCodeReader();
    let controls: IScannerControls | undefined;
    let cancelled = false;

    reader
      .decodeFromVideoDevice(undefined, videoRef.current!, (result, _err, scannerControls) => {
        if (cancelled) return;
        controls = scannerControls;
        if (!result) return;
        const text = result.getText();
        const code = extractQrCode(text);
        if (!code) {
          setError('Unrecognized QR format.');
          return;
        }
        scannerControls.stop();
        router.replace(`/q/${code}`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [router]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-4 py-4">
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
