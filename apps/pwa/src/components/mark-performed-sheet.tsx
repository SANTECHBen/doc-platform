'use client';

// MarkPerformedSheet — bottom-sheet evidence-capture dialog for logging
// one or more PMs as performed without running the full procedure.
//
// Supports two flows:
//
//   • Single-item: tech taps "Mark performed" on a Schedule or Plan-
//     Bucket card. The sheet opens with that item, prompts for optional
//     notes, and logs on confirm.
//
//   • Batch (bundling): tech taps "Mark all due performed" at the top
//     of the Scheduled slice. The sheet opens with the full list of due
//     items, shared notes apply to every record. Logs run in parallel
//     on confirm; toast surfaces the count.
//
// Notes are the only evidence channel the backend currently accepts on
// the shortcut path (createPmServiceRecord / createPmPlanServiceRecord
// both pass notes through to the service record). Photo, measurement,
// and signature capture require schema additions and are surfaced as
// "Coming soon" in the sheet so authors know the gap exists.

import { useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useDialogChrome } from '@/lib/use-dialog-chrome';

export interface MarkableItem {
  /** Stable key — used as the React key when rendering the list and
   *  also to avoid double-logging the same item across rapid taps. */
  key: string;
  /** Display label shown in the sheet. Typically the schedule name or
   *  "{plan name} · {bucket frequency}". */
  label: string;
}

export interface MarkPerformedSheetProps {
  /** Items to be logged. One item = single-mark flow. Multiple = batch. */
  items: MarkableItem[];
  /** Submitting state from the parent; drives the Log button's spinner. */
  busy: boolean;
  onClose: () => void;
  /** Receives the notes captured (may be empty string). Parent owns the
   *  actual API calls + refresh. */
  onConfirm: (notes: string) => void;
}

export function MarkPerformedSheet({
  items,
  busy,
  onClose,
  onConfirm,
}: MarkPerformedSheetProps) {
  const [notes, setNotes] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogChrome({ open: true, onClose, dialogRef });

  const isBatch = items.length > 1;
  const title = isBatch
    ? `Log ${items.length} PMs as performed`
    : `Log ${items[0]?.label ?? 'PM'} as performed`;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    onConfirm(notes.trim());
  }

  return (
    <>
      <div
        className="create-sheet-backdrop"
        data-open="true"
        onClick={onClose}
        aria-hidden
      />
      <aside
        ref={dialogRef}
        className="create-sheet mark-sheet"
        data-open="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="create-sheet-handle" aria-hidden />
        <header className="create-sheet-header">
          <h2 id={titleId} className="create-sheet-title">
            {title}
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

        {isBatch && (
          <ul className="mark-sheet-items" aria-label="PMs to be logged">
            {items.map((it) => (
              <li key={it.key}>
                <span className="led led-ok" aria-hidden />
                <span>{it.label}</span>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={onSubmit} className="mark-sheet-form">
          <label className="mark-sheet-field">
            <span className="cap-mono">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                isBatch
                  ? 'Same note applies to every PM logged. e.g. "Lubed all conveyors in zone A — bearings in spec, no anomalies."'
                  : 'What did you do? Anything notable? Used parts? Time taken?'
              }
              rows={4}
              maxLength={1024}
              autoFocus
              className="form-textarea"
            />
            <p className="mark-sheet-hint">
              Photo, measurement, and signature capture are coming in a
              future release. For now, notes are the evidence channel on
              the Mark Performed shortcut.
            </p>
          </label>

          <div className="mark-sheet-actions">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="btn btn-secondary btn-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`btn btn-primary btn-lg ${busy ? 'btn-loading' : ''}`}
            >
              {isBatch ? `Log ${items.length} PMs` : 'Log'}
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
