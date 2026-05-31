'use client';

// Shared modal/dialog chrome behavior used across PWA overlays:
//
//   • Body scroll lock while the dialog is open
//   • Escape key closes the dialog
//   • Focus trap (Tab and Shift+Tab cycle inside the dialog)
//   • Initial focus moves into the dialog on open
//   • Focus restoration: on close, focus returns to the element that
//     opened the dialog
//
// Pass the ref of the dialog container so the hook can scope its
// focusable-element queries to the dialog's subtree.

import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0,
  );
}

export function useDialogChrome({
  open,
  onClose,
  dialogRef,
}: {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    const opener = (document.activeElement as HTMLElement | null) ?? null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog — first focusable, or the dialog itself
    // (made focusable via tabindex=-1) when no interactive child exists.
    const first = focusableElements(dialog)[0];
    if (first) {
      first.focus();
    } else if (dialog) {
      dialog.focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const focusables = focusableElements(dialog);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusables[0]!;
      const lastEl = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === firstEl || !dialog.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (active === lastEl || !dialog.contains(active)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      // Restore focus to whatever opened the dialog. Guard because the
      // opener may have unmounted while the dialog was up.
      if (opener && document.contains(opener)) {
        try {
          opener.focus();
        } catch {
          /* opener disappeared between activeElement read and now */
        }
      }
    };
  }, [open, onClose, dialogRef]);
}
