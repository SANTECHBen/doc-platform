'use client';

import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

export type IllustrationProps = { size?: number; className?: string };

export function EmptyState({
  icon: Icon,
  illustration: Illustration,
  title,
  description,
  action,
  tone = 'info',
}: {
  /** Lucide icon used when no illustration is supplied. */
  icon?: LucideIcon;
  /** Bespoke thin-line SVG illustration; preferred over a lucide icon
   *  when present. Component must accept `{size, className}` and use
   *  `currentColor` so it inherits ink from the surrounding tone. */
  illustration?: ComponentType<IllustrationProps>;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: 'info' | 'ok' | 'warn' | 'fault' | 'safety' | 'neutral';
}) {
  const toneInk =
    tone === 'neutral'
      ? 'text-ink-secondary'
      : tone === 'ok'
      ? 'text-signal-ok'
      : tone === 'warn'
      ? 'text-signal-warn'
      : tone === 'fault'
      ? 'text-signal-fault'
      : tone === 'safety'
      ? 'text-signal-safety'
      : 'text-brand-strong';
  return (
    <div className="flex flex-col items-center justify-center gap-5 rounded-md border border-dashed border-line bg-surface-raised px-6 py-14 text-center">
      {Illustration ? (
        <Illustration size={140} className={toneInk} />
      ) : Icon ? (
        <div className={`icon-chip icon-chip-lg icon-chip-${tone}`}>
          <Icon size={26} strokeWidth={1.75} />
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3 className="text-base font-semibold text-ink-primary">{title}</h3>
        {description && <p className="text-sm text-ink-secondary">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-signal-fault/40 bg-signal-fault/10 px-3 py-2 text-sm text-signal-fault">
      {error}
    </div>
  );
}
