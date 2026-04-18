'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { TopBar } from './top-bar';
import { Breadcrumbs } from './breadcrumbs';

// Every admin page renders inside this shell — sticky top bar with breadcrumbs
// + quick-find, plus a centered max-width content area with consistent padding.
export function PageShell({
  crumbs,
  children,
}: {
  crumbs: Array<{ label: string; href?: string }>;
  children: ReactNode;
}) {
  return (
    <>
      <TopBar>
        <Breadcrumbs items={crumbs} />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        {children}
      </div>
    </>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-6 border-b border-line pb-5">
      <div className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-primary">{title}</h1>
        {description && (
          <p className="mt-1.5 text-base text-ink-secondary">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function DataLoader<T>({
  load,
  empty,
  children,
  deps = [],
}: {
  load: () => Promise<T>;
  empty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  deps?: unknown[];
}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (error)
    return (
      <div className="rounded-md border border-signal-fault/30 bg-signal-fault/10 p-4 text-sm text-signal-fault">
        {error}
      </div>
    );
  if (data === null)
    return (
      <div className="flex items-center justify-center rounded-md border border-line-subtle bg-surface-raised p-10 text-sm text-ink-tertiary">
        Loading…
      </div>
    );
  if (empty && empty(data))
    return (
      <div className="flex items-center justify-center rounded-md border border-dashed border-line bg-surface-raised p-10 text-sm text-ink-tertiary">
        Nothing to show yet.
      </div>
    );
  return <>{children(data)}</>;
}

export function MetricTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'default' | 'warning' | 'success' | 'danger';
}) {
  const toneClass =
    tone === 'warning'
      ? 'text-signal-warn'
      : tone === 'success'
      ? 'text-signal-ok'
      : tone === 'danger'
      ? 'text-signal-fault'
      : 'text-ink-primary';
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line-subtle bg-surface-raised p-5">
      <p className="caption">{label}</p>
      <p className={`font-mono text-3xl font-semibold tabular-nums leading-none ${toneClass}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-ink-tertiary">{sub}</p>}
    </div>
  );
}

export function Pill({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}) {
  const cls = `pill pill-${tone}`;
  return <span className={cls}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`overflow-hidden rounded-md border border-line-subtle bg-surface-raised ${className}`}
    >
      {children}
    </div>
  );
}
