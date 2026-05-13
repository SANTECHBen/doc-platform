'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

// ImageZoom — wraps any visual (image, logo, branded mark) and renders
// a fullscreen lightbox when tapped. Locks body scroll and supports
// keyboard dismiss (Esc) + tap-outside dismiss + close button.
//
// Pass children when the trigger needs custom styling (e.g. an <img>
// inside a framed div). Omit children to get a plain <img> trigger.

interface Props {
  src: string;
  alt: string;
  /** Custom trigger content. When omitted, renders a plain <img>. */
  children?: React.ReactNode;
  /** Aria label override for the trigger button. */
  triggerLabel?: string;
}

export function ImageZoom({
  src,
  alt,
  children,
  triggerLabel,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={triggerLabel ?? `Enlarge ${alt || 'image'}`}
        className="block cursor-zoom-in border-0 bg-transparent p-0"
      >
        {children ?? <img src={src} alt={alt} draggable={false} />}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[200] flex flex-col"
          style={{ background: 'rgb(var(--surface-base) / 0.95)' }}
          role="dialog"
          aria-modal="true"
          aria-label={`Enlarged: ${alt || 'image'}`}
          onClick={() => setOpen(false)}
        >
          <header className="flex items-center justify-end p-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="app-topbar-btn"
              aria-label="Close enlarged image"
            >
              <X size={20} strokeWidth={2} />
            </button>
          </header>
          <div
            className="flex flex-1 items-center justify-center overflow-auto p-4"
            style={{ touchAction: 'pinch-zoom' }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt={alt}
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          </div>
        </div>
      )}
    </>
  );
}
