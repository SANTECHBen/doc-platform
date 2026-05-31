'use client';

export interface ErrorBannerProps {
  error: string | null | undefined;
  /** Extra classes (typically used for spacing — `mb-4` etc.). The
   *  banner itself has no margin by default, so callers can stack it
   *  inside any container without surprises. */
  className?: string;
}

// ErrorBanner — the small red-tinted "something failed" strip that
// appears at the top of a list or form. No baked-in margin so the
// caller controls spacing.
export function ErrorBanner({ error, className }: ErrorBannerProps) {
  if (!error) return null;
  return (
    <div
      className={`rounded-md border border-signal-fault/40 bg-signal-fault/10 px-3 py-2 text-sm text-signal-fault${
        className ? ` ${className}` : ''
      }`}
      role="alert"
    >
      {error}
    </div>
  );
}
