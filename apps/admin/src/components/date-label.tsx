'use client';

import { useEffect, useState } from 'react';

// Renders a timestamp formatted in the viewer's local timezone WITHOUT
// causing an SSR/CSR hydration mismatch.
//
// Naive `new Date(iso).toLocaleString()` produces different output on
// the server (UTC) vs the client (the user's locale + timezone), which
// trips React error #418 on hydrate. We dodge that by emitting an empty
// span on first render and filling it in once useEffect runs on the
// client.

interface Props {
  iso: string | null | undefined;
  /** date = "12/3/2026"  ·  datetime = "12/3/2026, 4:15 PM"
   *  time = "4:15:23 PM" */
  mode?: 'date' | 'datetime' | 'time';
  /** Fallback when iso is null/undefined or unparseable. */
  fallback?: string;
}

export function DateLabel({ iso, mode = 'datetime', fallback = '' }: Props) {
  const [text, setText] = useState<string>('');
  useEffect(() => {
    if (!iso) {
      setText(fallback);
      return;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      setText(fallback);
      return;
    }
    if (mode === 'date') setText(d.toLocaleDateString());
    else if (mode === 'time') setText(d.toLocaleTimeString());
    else setText(d.toLocaleString());
  }, [iso, mode, fallback]);
  // suppressHydrationWarning belt-and-suspenders: even though we keep
  // first render empty, the fallback string could differ across reruns
  // if a parent forces a remount. Empty text is the most common branch.
  return <span suppressHydrationWarning>{text}</span>;
}
