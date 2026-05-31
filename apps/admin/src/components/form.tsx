'use client';

import { useId, useRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { useDialogChrome } from '@/lib/use-dialog-chrome';

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={`form-label${required ? ' form-label-required' : ''}`}>{label}</span>
      {children}
      {error ? (
        <span className="form-error">{error}</span>
      ) : (
        hint && <span className="form-hint">{hint}</span>
      )}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`form-input ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`form-select ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`form-textarea ${props.className ?? ''}`} />;
}

export function PrimaryButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button {...props} className={`btn btn-primary ${className ?? ''}`}>
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button {...props} className={`btn btn-secondary ${className ?? ''}`}>
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button {...props} className={`btn btn-ghost ${className ?? ''}`}>
      {children}
    </button>
  );
}

export function Drawer({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogChrome({ open, onClose, dialogRef });
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex h-full w-full max-w-xl flex-col bg-surface-raised shadow-2xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}

// Full-screen overlay for editors that need real estate (multi-pane forms,
// PDF previews, video players, etc.). Locks body scroll and traps the user
// until they save/cancel. Children are responsible for layout inside.
export function FullPageOverlay({
  title,
  subtitle,
  open,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogChrome({ open, onClose, dialogRef });
  if (!open) return null;
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-surface-base focus:outline-none"
    >
      <header className="flex items-center justify-between border-b border-line bg-surface-raised px-6 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-lg font-semibold text-ink-primary">
            {title}
          </h2>
          {subtitle && <p className="truncate text-xs text-ink-tertiary">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-elevated hover:text-ink-primary"
          aria-label="Close"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>
      {/* The single scroll context for tall forms. Body scroll above
          is locked so this is the only scrollbar the user sees. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
    </div>
  );
}

// ErrorBanner — thin wrapper over @platform/ui's shared ErrorBanner.
// Defaults to `mb-4` because admin call sites (~70 today) rely on the
// historical baked-in margin to stack cleanly above the form body.
// New callers can opt out by passing className="".
import { ErrorBanner as SharedErrorBanner } from '@platform/ui';

export function ErrorBanner({
  error,
  className = 'mb-4',
}: {
  error: string | null;
  className?: string;
}) {
  return <SharedErrorBanner error={error} className={className} />;
}
