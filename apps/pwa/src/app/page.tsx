import Link from 'next/link';
import { QrCode, ScanLine } from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';

export default function Home() {
  return (
    <main id="main" tabIndex={-1} className="relative mx-auto flex min-h-screen max-w-md flex-col px-6 py-6 focus:outline-none">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[60%]"
        style={{
          background:
            'radial-gradient(ellipse at 50% 20%, rgb(var(--brand) / 0.1), transparent 60%)',
        }}
      />

      <header className="relative flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="brand-mark-square">FS</div>
          <span className="text-sm font-semibold">FieldSupport</span>
        </div>
        <ThemeToggle />
      </header>

      <div className="relative mt-auto flex flex-col items-center gap-5 pt-12 text-center">
        <div className="qr-tile">
          {/* Lucide QrCode icon — replaces a hand-rolled SVG pixel-art
              approximation. Same 50px target, stroke-based rendering
              for a sharper look on high-DPI screens. */}
          <QrCode
            size={50}
            strokeWidth={1.5}
            className="text-ink-primary opacity-90"
            aria-hidden
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-brand">
            Ready to scan
          </span>
          <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.026em]">
            Scan to begin.
          </h1>
          <p className="max-w-[280px] text-sm leading-[1.55] text-ink-secondary">
            Point your camera at the QR sticker on the equipment. Docs, training,
            parts, grounded AI — all for this exact serial.
          </p>
        </div>
      </div>

      <div className="relative mt-auto flex flex-col items-center gap-3 pt-10">
        <Link href="/scan" className="scan-btn">
          <ScanLine size={18} strokeWidth={2} />
          Scan equipment
        </Link>
        <p className="max-w-[280px] text-center text-xs text-ink-tertiary">
          Hands busy? Hold the QR steady — the hub loads in under a second.
        </p>
      </div>
    </main>
  );
}
