'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'info',
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: 'info' | 'ok' | 'warn' | 'fault' | 'safety' | 'neutral';
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed border-line bg-surface-raised px-6 py-14 text-center">
      <div className={`icon-chip icon-chip-lg icon-chip-${tone}`}>
        <Icon size={26} strokeWidth={1.75} />
      </div>
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
