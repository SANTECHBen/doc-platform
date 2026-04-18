'use client';

import Link from 'next/link';
import { ChevronRight, Home } from 'lucide-react';

export function Breadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>;
}) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-ink-tertiary" aria-label="Breadcrumb">
      <Link
        href="/"
        className="inline-flex items-center text-ink-tertiary transition hover:text-ink-primary"
        aria-label="Dashboard"
      >
        <Home size={14} strokeWidth={2} />
      </Link>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            <ChevronRight size={14} strokeWidth={2} className="text-line-strong" />
            {item.href && !last ? (
              <Link href={item.href} className="transition hover:text-ink-primary">
                {item.label}
              </Link>
            ) : (
              <span className={last ? 'font-medium text-ink-primary' : ''}>
                {item.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
