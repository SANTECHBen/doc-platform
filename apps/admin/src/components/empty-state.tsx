'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed border-line bg-surface-raised px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-brand-strong">
        <Icon size={26} strokeWidth={1.75} />
      </div>
      <div className="flex max-w-md flex-col gap-1.5">
        <h3 className="text-lg font-semibold text-ink-primary">{title}</h3>
        <p className="text-sm text-ink-secondary">{description}</p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
