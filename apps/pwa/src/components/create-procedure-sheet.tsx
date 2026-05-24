'use client';

// CreateProcedureSheet — bottom-sheet picker that opens when the tech
// taps the center "+" FAB in the asset hub tabbar. Two tiles:
//
//   * AI walkthrough — record a video, the AI drafter slices it into
//     steps for admin review. Backed by the existing VideoSubmission
//     overlay.
//   * Manual procedure — step-by-step capture in the field, exactly the
//     same wizard that used to live on the Maintenance tab.
//
// The sheet is intentionally short: two choices, a cancel target. No
// nested options. Anything more reads as a settings panel — this is a
// reflex picker, not a dashboard.
//
// Dismiss behaviors:
//   * Tap a tile  → onPick fires; parent unmounts the sheet.
//   * Tap the backdrop or Cancel.
//   * Drag handle downward by > 80px.
//   * Escape key.
//
// Implementation notes:
//   * No portal — we render inline; the absolute-positioned panel uses
//     viewport-fixed coordinates so it lifts above whatever's behind.
//   * IOS PWA: overscroll-behavior: contain on the sheet body so a drag
//     past the bottom doesn't pull-to-refresh the hub.

import { useCallback, useEffect, useRef } from 'react';
import { Camera, ListOrdered, X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (mode: 'ai' | 'manual') => void;
}

export function CreateProcedureSheet({ open, onClose, onPick }: Props) {
  // Drag-to-close. Track the gesture's vertical delta; over 80px → close.
  // Refs (not state) because we'd rather not trigger renders on every
  // touchmove tick.
  const startYRef = useRef<number | null>(null);
  const deltaRef = useRef<number>(0);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startYRef.current = t.clientY;
    deltaRef.current = 0;
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (startYRef.current == null) return;
    const t = e.touches[0];
    if (!t) return;
    deltaRef.current = t.clientY - startYRef.current;
  }, []);
  const onTouchEnd = useCallback(() => {
    if (deltaRef.current > 80) onClose();
    startYRef.current = null;
    deltaRef.current = 0;
  }, [onClose]);

  // Close on Escape — even on a touch device, keyboards may be attached
  // (BT keyboard while on a maintenance laptop running the PWA).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while the sheet is open so flicking the tile
  // doesn't scroll the hub behind it.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <div
        className="create-sheet-backdrop"
        data-open={open ? 'true' : 'false'}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="create-sheet"
        data-open={open ? 'true' : 'false'}
        role="dialog"
        aria-modal="true"
        aria-label="Document a procedure"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="create-sheet-handle" aria-hidden />
        <header className="create-sheet-header">
          <h2 className="create-sheet-title">
            How do you want to capture this procedure?
          </h2>
          <button
            type="button"
            className="create-sheet-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </header>
        <div className="create-sheet-tiles">
          <button
            type="button"
            className="create-sheet-tile"
            onClick={() => onPick('ai')}
          >
            <span className="create-sheet-tile-icon" aria-hidden>
              <Camera size={24} strokeWidth={2} />
            </span>
            <span className="create-sheet-tile-body">
              <span className="create-sheet-tile-title">AI walkthrough</span>
              <span className="create-sheet-tile-sub">
                Film the procedure once. AI drafts the steps for an admin to review.
              </span>
            </span>
          </button>
          <button
            type="button"
            className="create-sheet-tile"
            onClick={() => onPick('manual')}
          >
            <span className="create-sheet-tile-icon" aria-hidden>
              <ListOrdered size={24} strokeWidth={2} />
            </span>
            <span className="create-sheet-tile-body">
              <span className="create-sheet-tile-title">Manual procedure</span>
              <span className="create-sheet-tile-sub">
                Capture each step yourself — title, photo, notes — as you work.
              </span>
            </span>
          </button>
        </div>
        <button
          type="button"
          className="create-sheet-cancel"
          onClick={onClose}
        >
          Cancel
        </button>
      </aside>
    </>
  );
}
