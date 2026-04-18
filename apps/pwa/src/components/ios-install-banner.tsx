'use client';

import { useEffect, useState } from 'react';
import { Share, X } from 'lucide-react';

// Nudges iPad/iPhone users running in Safari to add the PWA to their home
// screen. Once installed, the shell hides permanent Safari chrome and the
// app feels native. Chrome/Edge have their own install prompt — this only
// triggers for iOS Safari.
const DISMISS_KEY = 'eh.ios-install.dismissed';

export function IOSInstallBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    if (!isIOS) return;
    // Already running standalone — nothing to do.
    const standalone =
      (window.navigator as any).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    if (standalone) return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="mx-auto mt-2 flex max-w-3xl items-center gap-3 rounded-md border px-3 py-2 text-sm"
      style={{
        background: 'rgb(var(--surface-raised))',
        borderColor: 'rgb(var(--line-subtle))',
        color: 'rgb(var(--ink-secondary))',
      }}
    >
      <Share size={18} strokeWidth={1.75} style={{ color: 'rgb(var(--brand))' }} />
      <div className="flex-1">
        <span className="text-ink-primary">Install for a tablet-app feel.</span>{' '}
        Tap <span className="font-semibold">Share</span> →{' '}
        <span className="font-semibold">Add to Home Screen</span>.
      </div>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, '1');
          setVisible(false);
        }}
        className="p-1 text-ink-tertiary hover:text-ink-primary"
        aria-label="Dismiss"
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}
