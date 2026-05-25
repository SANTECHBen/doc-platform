'use client';

// Modal for naming a design and saving it to local storage. Opens from the
// designer header. When editing an existing saved design (mode === 'update'),
// the modal lets the user choose between overwriting the original or saving
// as a brand-new entry under a fresh name.

import { useEffect, useState } from 'react';
import { Loader2, Save, X } from 'lucide-react';
import { saveDesign, type SavedDesign } from '@/lib/qr-designer-storage';
import type { QrStyleSpec } from '@/lib/qr-style';

export interface SaveDesignModalProps {
  spec: QrStyleSpec;
  /** When editing a previously-saved design, pass the entry — the modal
   *  uses its name as the default and offers an "Update" action. */
  existing?: SavedDesign | null;
  /** Sensible default name when there is no existing entry. */
  defaultName: string;
  onClose: () => void;
  onSaved: (design: SavedDesign) => void;
}

export function SaveDesignModal({
  spec,
  existing,
  defaultName,
  onClose,
  onSaved,
}: SaveDesignModalProps) {
  const [name, setName] = useState(existing?.name ?? defaultName);
  const [mode, setMode] = useState<'update' | 'new'>(existing ? 'update' : 'new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function doSave() {
    setBusy(true);
    setError(null);
    try {
      const saved = saveDesign({
        id: mode === 'update' && existing ? existing.id : undefined,
        name,
        spec,
      });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-primary/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={() => !busy && onClose()}
    >
      <form
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-line bg-surface-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) doSave();
        }}
      >
        <header className="flex items-center justify-between border-b border-line-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-ink-primary">
            {existing ? 'Save design' : 'Save new design'}
          </h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="rounded p-1 text-ink-tertiary transition hover:bg-surface-inset hover:text-ink-primary"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-secondary">Design name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Brand blue with logo"
              className="rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
            />
          </label>

          {existing && (
            <div className="space-y-2 rounded-md border border-line-subtle bg-surface-inset/40 p-3 text-xs">
              <p className="text-ink-secondary">
                You opened <span className="font-medium text-ink-primary">{existing.name}</span>.
                Save how?
              </p>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    checked={mode === 'update'}
                    onChange={() => setMode('update')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-ink-primary">Update existing</span>
                    <br />
                    Replace the saved entry with the current design.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    checked={mode === 'new'}
                    onChange={() => setMode('new')}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-ink-primary">Save as new</span>
                    <br />
                    Keep the original and add this as a separate design.
                  </span>
                </label>
              </div>
            </div>
          )}

          {error && (
            <p className="rounded border border-signal-fault/40 bg-signal-fault/10 p-2 text-xs text-signal-fault">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line-subtle bg-surface-inset/40 px-5 py-3">
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="rounded border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded btn-primary px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={12} strokeWidth={2} className="animate-spin" />
            ) : (
              <Save size={12} strokeWidth={2} />
            )}
            {existing && mode === 'update' ? 'Update design' : 'Save design'}
          </button>
        </footer>
      </form>
    </div>
  );
}
