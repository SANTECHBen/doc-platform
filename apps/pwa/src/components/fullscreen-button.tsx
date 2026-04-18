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
    setSupported(true);

    const onChange = () => {
      const active =
        !!document.fullscreenElement || !!(document as any).webkitFullscreenElement;
      setIsFs(active);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);

    // Fire once on the first user tap. Browsers need a gesture; by listening
    // pointerdown with capture we catch virtually any interaction.
    let triggered = false;
    const onFirstTap = () => {
      if (triggered) return;
      triggered = true;
      window.removeEventListener('pointerdown', onFirstTap, true);
      // Fail silently — some embedded browsers (in-app webviews) reject.
      (el.requestFullscreen || el.webkitRequestFullscreen)
        ?.call(el)
        .catch(() => {});
    };
    window.addEventListener('pointerdown', onFirstTap, true);

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
