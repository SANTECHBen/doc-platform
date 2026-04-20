'use client';

import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

// Requests fullscreen on the first tap anywhere on the page (browsers reject
// requests outside a user gesture), and exposes a manual toggle button.
// Silent no-op on platforms that don't support the API (e.g. iPhone Safari).
export function FullscreenButton() {
  const [supported, setSupported] = useState(false);
  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement as any;
    const has =
      typeof el.requestFullscreen === 'function' ||
      typeof el.webkitRequestFullscreen === 'function';
    if (!has) return;

    // If we're in an iframe or a context where fullscreen isn't allowed
    // (some in-app webviews, Vercel preview chrome, CSP-restricted pages),
    // requestFullscreen will reject AND log a console warning before the
    // catch runs. Skip the auto-enter in that case.
    const canFullscreen =
      document.fullscreenEnabled || (document as any).webkitFullscreenEnabled;
    setSupported(true);

    const onChange = () => {
      const active =
        !!document.fullscreenElement || !!(document as any).webkitFullscreenElement;
      setIsFs(active);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);

    // Auto-enter on first tap — but only where the browser will actually
    // honor it. Otherwise the manual button still works when the user taps it.
    let triggered = false;
    const onFirstTap = () => {
      if (triggered) return;
      triggered = true;
      window.removeEventListener('pointerdown', onFirstTap, true);
      if (!canFullscreen) return;
      (el.requestFullscreen || el.webkitRequestFullscreen)
        ?.call(el)
        .catch(() => {});
    };
    if (canFullscreen) {
      window.addEventListener('pointerdown', onFirstTap, true);
    }

    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      window.removeEventListener('pointerdown', onFirstTap, true);
    };
  }, []);

  if (!supported) return null;

  async function toggle() {
    const el = document.documentElement as any;
    try {
      if (isFs) {
        await (document.exitFullscreen ?? (document as any).webkitExitFullscreen)?.call(
          document,
        );
      } else {
        await (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
      }
    } catch {
      // ignore
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="app-topbar-btn"
      aria-label={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
      title={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
    >
      {isFs ? <Minimize2 size={18} strokeWidth={2} /> : <Maximize2 size={18} strokeWidth={2} />}
    </button>
  );
}
