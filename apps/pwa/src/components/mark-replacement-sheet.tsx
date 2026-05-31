'use client';

// MarkReplacementSheet — bottom-sheet dialog for filing a "needs
// replacement" work order from the Part Inspector. The tech selects
// severity, optionally describes symptoms, and (optionally) types a
// "Reported by" name that persists per-device.
//
// Reporter attribution model: the PWA is deliberately auth-free, so
// the work-order API attributes openedByUserId = null on every PWA
// write. To give downstream readers (maintenance managers, dispatch)
// SOMETHING in the "who" slot, we capture a free-text name and append
// it to the work-order description ("Reported by: L. Martinez ·
// scanned via shop-floor tablet"). The name persists in localStorage
// keyed by device so the tech sets it once and it carries forward to
// every subsequent report on the same device.
//
// Cleared by the same "Clear my session" affordance that's queued
// elsewhere in the IA — shared tablets need a way to wipe per-device
// state for the next tech.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { useDialogChrome } from '@/lib/use-dialog-chrome';

export type WorkOrderSeverity = 'low' | 'medium' | 'high' | 'critical';

const REPORTER_NAME_KEY = 'fs:reporter-name';

const SEVERITY_OPTIONS: Array<{
  value: WorkOrderSeverity;
  label: string;
  hint: string;
}> = [
  { value: 'low', label: 'Low', hint: 'Watch and reorder' },
  { value: 'medium', label: 'Medium', hint: 'Schedule replacement' },
  { value: 'high', label: 'High', hint: 'Replace this week' },
  { value: 'critical', label: 'Critical', hint: 'Replace immediately' },
];

export interface MarkReplacementSheetProps {
  /** Display label for the part being reported. Shown in the sheet
   *  title and used in the auto-generated work-order title. */
  partLabel: string;
  /** OEM part number, surfaced in the auto-generated description so
   *  procurement can act without cross-referencing. */
  partNumber?: string | null;
  /** Submitting state from the parent; drives the Create button's
   *  spinner. */
  busy: boolean;
  onClose: () => void;
  /** Receives the captured payload — title + severity + description
   *  combined with reporter attribution. Parent owns the createWorkOrder
   *  call so it can route the response into its own state (refresh
   *  open-issues, toast, etc.). */
  onConfirm: (payload: {
    title: string;
    description: string;
    severity: WorkOrderSeverity;
  }) => void;
}

export function MarkReplacementSheet({
  partLabel,
  partNumber,
  busy,
  onClose,
  onConfirm,
}: MarkReplacementSheetProps) {
  const [severity, setSeverity] = useState<WorkOrderSeverity>('medium');
  const [notes, setNotes] = useState('');
  const [reporter, setReporter] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogChrome({ open: true, onClose, dialogRef });

  // Pre-fill the reporter name from localStorage on mount. The tech
  // sets it once; it carries forward across reports.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(REPORTER_NAME_KEY);
      if (stored) setReporter(stored);
    } catch {
      /* localStorage unavailable in private mode / locked browsers */
    }
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    // Persist the reporter name for next time. Empty string clears
    // the stored value (so a user who deletes the field on a shared
    // device doesn't leave their name behind).
    const reporterTrimmed = reporter.trim();
    if (typeof window !== 'undefined') {
      try {
        if (reporterTrimmed) {
          window.localStorage.setItem(REPORTER_NAME_KEY, reporterTrimmed);
        } else {
          window.localStorage.removeItem(REPORTER_NAME_KEY);
        }
      } catch {
        /* ignore */
      }
    }

    const pnSuffix = partNumber?.trim() ? ` (${partNumber.trim()})` : '';
    const title = `Replacement needed: ${partLabel}${pnSuffix}`;

    const notesTrimmed = notes.trim();
    const lines: string[] = [];
    if (notesTrimmed) lines.push(notesTrimmed);
    if (reporterTrimmed) lines.push(`Reported by: ${reporterTrimmed}`);
    const description = lines.join('\n\n');

    onConfirm({ title, description, severity });
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
            Mark needs replacement
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

        <p className="mark-replacement-target">
          <span className="cap-mono">Part</span>
          <strong>{partLabel}</strong>
          {partNumber && (
            <span className="mark-replacement-target-pn">{partNumber}</span>
          )}
        </p>

        <form onSubmit={onSubmit} className="mark-sheet-form">
          <fieldset className="mark-replacement-severity">
            <legend className="cap-mono">Urgency</legend>
            <div className="mark-replacement-severity-grid" role="radiogroup">
              {SEVERITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSeverity(opt.value)}
                  role="radio"
                  aria-checked={severity === opt.value}
                  data-active={severity === opt.value ? 'true' : 'false'}
                  data-severity={opt.value}
                  className="mark-replacement-severity-card"
                >
                  <span className="mark-replacement-severity-label">
                    {opt.label}
                  </span>
                  <span className="mark-replacement-severity-hint">
                    {opt.hint}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="mark-sheet-field">
            <span className="cap-mono">Symptoms (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='e.g. "Noisy bearing on startup, runs hot after 2 hours. Replaced March 2024."'
              rows={3}
              maxLength={1024}
              className="form-textarea"
            />
          </label>

          <label className="mark-sheet-field">
            <span className="cap-mono">Reported by (optional)</span>
            <input
              type="text"
              value={reporter}
              onChange={(e) => setReporter(e.target.value)}
              placeholder="e.g. L. Martinez"
              maxLength={64}
              className="form-input"
            />
            <p className="mark-sheet-hint">
              Saved on this device so you don&rsquo;t have to type it for
              every report. Clear the field to remove it.
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
              Create work order
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
