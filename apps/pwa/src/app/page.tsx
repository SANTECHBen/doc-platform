import Link from 'next/link';
import { ScanLine } from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';

export default function Home() {
  return (
    <main className="relative mx-auto flex min-h-screen max-w-md flex-col px-6 py-6">
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
          <div className="brand-mark-square">EH</div>
          <span className="text-sm font-semibold">Equipment Hub</span>
        </div>
        <ThemeToggle />
      </header>

      <div className="relative mt-auto flex flex-col items-center gap-5 pt-12 text-center">
        <div className="qr-tile">
          <svg
            width="50"
            height="50"
            viewBox="0 0 50 50"
            className="text-ink-primary opacity-90"
            fill="currentColor"
            aria-hidden
          >
            <path d="M0 0h14v14H0zm4 4v6h6V4H4z M36 0h14v14H36zm4 4v6h6V4h-6z M0 36h14v14H0zm4 4v6h6v-6H4z M18 0h4v4h-4z M26 0h4v8h-4z M18 6h4v4h-4z M22 10h4v4h-4z M30 8h6v4h-6z M18 14h4v8h-4z M26 14h8v4h-8z M24 18h4v4h-4z M30 22h6v4h-6z M40 18h6v4h-6z M18 26h4v4h-4z M24 26h6v4h-6z M34 26h4v4h-4z M42 30h4v4h-4z M20 32h8v4h-8z M30 32h4v8h-4z M18 38h4v8h-4z M24 40h4v4h-4z M36 36h6v4h-6z M44 36h4v10h-4z M28 44h4v4h-4z M38 44h4v4h-4z" />
          </svg>
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
