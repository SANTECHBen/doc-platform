'use client';

import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

export type IllustrationProps = { size?: number; className?: string };
export type EmptyStateTone = 'info' | 'ok' | 'warn' | 'fault' | 'safety' | 'neutral';

export interface EmptyStateProps {
  /** Lucide icon used when no illustration is supplied. */
  icon?: LucideIcon;
  /** Bespoke thin-line SVG illustration; preferred over a lucide icon
   *  when present. Component must accept `{size, className}` and use
   *  `currentColor` so it inherits ink from the surrounding tone. */
  illustration?: ComponentType<IllustrationProps>;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: EmptyStateTone;
}

// EmptyState — the dashed-border card used everywhere a list is empty
// or a search returns nothing. The PWA contract (illustration optional,
// tone-tinted icon-chip, description optional) is the better one and
// is the shared default; both apps' previous local implementations are
// now thin re-exports.
export function EmptyState({
  icon: Icon,
  illustration: Illustration,
  title,
  description,
  action,
  tone = 'info',
}: EmptyStateProps) {
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
