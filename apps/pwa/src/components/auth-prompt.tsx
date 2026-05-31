'use client';

// AuthPrompt — modal shown when an action requires an authenticated tech
// identity but none is available (e.g., no NEXT_PUBLIC_DEV_USER_ID and no
// OIDC session). Read-only docs/parts via QR scan stay unaffected; this
// only gates write paths like starting a procedure run.
//
// v1 stub: explains the constraint. Real OIDC sign-in flow (Microsoft
// Entra ID) is a follow-up that wires a "Sign in" button to the existing
// API auth setup. For now, dev environments set the env var and prod is
// pending integration.

import { useId, useRef } from 'react';
import { LogIn, X } from 'lucide-react';
import { useDialogChrome } from '@/lib/use-dialog-chrome';

export function AuthPrompt({
  reason = 'start a procedure',
  onClose,
}: {
  reason?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogChrome({ open: true, onClose, dialogRef });

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-md rounded-md border border-line bg-surface-raised p-5 shadow-lg focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="icon-chip icon-chip-info">
              <LogIn size={16} strokeWidth={2} />
            </div>
            <h3 id={titleId} className="text-base font-semibold text-ink-primary">
              Sign in required
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <p className="text-sm text-ink-secondary">
          You need to sign in with your work account to {reason}. Reading
          documentation via QR scan stays open — only writing evidence (photos,
          measurements, completion records) needs identity so the run is
          attributable to you.
        </p>
        <p className="mt-3 text-xs text-ink-tertiary">
          Sign-in is being wired up; until then, ask your administrator to provision
          access for this device.
        </p>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
