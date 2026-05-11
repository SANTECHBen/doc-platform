'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { getSection, type SectionBundle } from '@/lib/api';
import { SectionRenderer } from './section-renderer';

// SectionViewerOverlay — full-screen overlay that displays one
// `documentSections` row. Used by voice mode when the AI emits a
// [section:UUID] directive (the fallback path when no authored
// procedure matches the tech's question). Pure read-only — no step
// navigation, no evidence capture.

interface Props {
  sectionId: string;
  onClose: () => void;
}

export function SectionViewerOverlay({ sectionId, onClose }: Props): React.ReactElement {
  const [bundle, setBundle] = useState<SectionBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    (async () => {
      try {
        const result = await getSection(sectionId);
        if (cancelled) return;
        if (!result) {
          setError('That section is no longer available.');
          return;
        }
        setBundle(result);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load the section.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sectionId]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-surface-base"
      role="dialog"
      aria-label="Document section"
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          {bundle ? (
            <>
              <div className="truncate text-xs uppercase tracking-wide text-ink-tertiary">
                {bundle.document.title}
              </div>
              <div className="truncate text-base font-semibold text-ink-primary">
                {bundle.section.title}
              </div>
            </>
          ) : (
            <div className="text-sm text-ink-secondary">Loading section…</div>
          )}
        </div>
        <button
          type="button"
          className="ml-3 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-ink-secondary hover:bg-surface-elevated"
          onClick={onClose}
          aria-label="Close section"
        >
          <X size={18} strokeWidth={2.25} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {error ? (
          <p className="mx-auto max-w-md py-12 text-center text-sm text-ink-secondary">
            {error}
          </p>
        ) : bundle ? (
          <SectionRenderer doc={bundle.document} section={bundle.section} index={1} />
        ) : null}
      </div>
    </div>
  );
}
