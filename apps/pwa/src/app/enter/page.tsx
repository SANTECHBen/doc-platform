'use client';

// Manual equipment-ID entry — the secondary path off the home page when
// the QR sticker is damaged, obscured, or unreadable. The tech types the
// printed code (or pulls one from a work order) and we route through the
// same /q/<code> handler that a camera scan would hit, so the scan-
// session cookie is minted identically and the asset hub renders the
// same way.
//
// Visual composition mirrors the home page (tile + eyebrow + headline +
// description + bottom action area) so the two paths read as siblings.
// Hash icon replaces the QR icon to signal "type a code, don't scan one."

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Hash } from 'lucide-react';

export default function EnterIDPage() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const trimmed = value.trim();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    // Route through the same QR handler a camera scan would hit — mints
    // the scan-session cookie, sets ?intro=1, redirects to /a/<code>.
    // If the code is invalid, the asset hub itself will 404 and the
    // tech can press back.
    router.push(`/q/${encodeURIComponent(trimmed)}`);
  }

  return (
    <main
      id="main"
      tabIndex={-1}
      className="relative mx-auto flex min-h-screen max-w-md flex-col px-6 py-6 focus:outline-none"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[60%]"
        style={{
          background:
            'radial-gradient(ellipse at 50% 20%, rgb(var(--brand) / 0.1), transparent 60%)',
        }}
      />

      <header className="relative flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-ink-secondary transition hover:text-ink-primary"
          aria-label="Back to home"
        >
          <ChevronLeft size={18} strokeWidth={2} />
          Back
        </Link>
        <div className="flex items-center gap-2.5">
          <div className="brand-mark-square">FS</div>
          <span className="text-sm font-semibold">FieldSupport</span>
        </div>
      </header>

      <div className="relative mt-auto flex flex-col items-center gap-5 pt-12 text-center">
        <div className="qr-tile">
          <Hash
            size={50}
            strokeWidth={1.75}
            className="text-ink-primary opacity-90"
            aria-hidden
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-brand">
            Manual entry
          </span>
          <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.026em]">
            Type the ID.
          </h1>
          <p className="max-w-[280px] text-sm leading-[1.55] text-ink-secondary">
            Enter the code printed on the QR sticker, or paste an ID from
            a work order. Same asset hub, no camera needed.
          </p>
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="relative mt-auto flex flex-col items-center gap-3 pt-10"
      >
        <label className="flex w-full max-w-sm flex-col gap-2">
          <span className="sr-only">Equipment ID</span>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. EH-2X8K-FXM"
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={64}
            inputMode="text"
            // Larger 16px font on mobile prevents iOS Safari from
            // auto-zooming when the input receives focus.
            className="form-input font-mono text-base tracking-wider"
            aria-label="Equipment ID"
          />
        </label>
        <button
          type="submit"
          disabled={!trimmed || submitting}
          className={`btn btn-primary btn-lg w-full max-w-sm ${
            submitting ? 'btn-loading' : ''
          }`}
        >
          Open equipment hub
        </button>
        <p className="max-w-[280px] text-center text-xs text-ink-tertiary">
          IDs are typically 6–16 alphanumeric characters.
        </p>
      </form>
    </main>
  );
}
