'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  getDocument,
  getSection,
  type DocumentBody,
  type PwaDocumentSection,
  type SectionBundle,
} from '@/lib/api';
import { SectionRenderer } from './section-renderer';

// SectionViewerOverlay — full-screen overlay that displays either:
//   - An authored documentSections row (kind='section'), OR
//   - A synthetic page-range derived from the cited chunks
//     (kind='pdfpage') — used when the admin hasn't authored sections
//     on a PDF yet but the AI still needs to point at a specific page.
// Pure read-only — no step navigation, no evidence capture.

export type SectionViewerSource =
  | { kind: 'section'; sectionId: string }
  | { kind: 'pdfpage'; docId: string; pageStart: number; pageEnd: number };

interface Props {
  source: SectionViewerSource;
  onClose: () => void;
}

interface ResolvedBundle {
  doc: DocumentBody;
  section: PwaDocumentSection;
}

// Build an in-memory PwaDocumentSection from a page range. The shape
// matches what SectionRenderer expects for kind='page_range'; all other
// fields are nulled.
function buildSyntheticSection(
  source: Extract<SectionViewerSource, { kind: 'pdfpage' }>,
  doc: DocumentBody,
): PwaDocumentSection {
  const pageLabel =
    source.pageStart === source.pageEnd
      ? `Page ${source.pageStart}`
      : `Pages ${source.pageStart}–${source.pageEnd}`;
  return {
    id: `synthetic-${source.docId}-${source.pageStart}-${source.pageEnd}`,
    kind: 'page_range',
    title: pageLabel,
    description: doc.title,
    safetyCritical: false,
    orderingHint: 0,
    pageStart: source.pageStart,
    pageEnd: source.pageEnd,
    startY: null,
    endY: null,
    textPageHint: null,
    anchorExcerpt: null,
    anchorContextBefore: null,
    anchorContextAfter: null,
    timeStartSeconds: null,
    timeEndSeconds: null,
  };
}

export function SectionViewerOverlay({ source, onClose }: Props): React.ReactElement {
  const [bundle, setBundle] = useState<ResolvedBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    (async () => {
      try {
        if (source.kind === 'section') {
          const result: SectionBundle | null = await getSection(source.sectionId);
          if (cancelled) return;
          if (!result) {
            setError('That section is no longer available.');
            return;
          }
          setBundle({ doc: result.document, section: result.section });
        } else {
          const doc = await getDocument(source.docId);
          if (cancelled) return;
          if (!doc) {
            setError('That document is no longer available.');
            return;
          }
          setBundle({ doc, section: buildSyntheticSection(source, doc) });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load the section.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Key the effect on a stable serialization of the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    source.kind,
    source.kind === 'section' ? source.sectionId : '',
    source.kind === 'pdfpage' ? source.docId : '',
    source.kind === 'pdfpage' ? source.pageStart : 0,
    source.kind === 'pdfpage' ? source.pageEnd : 0,
  ]);

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
                {bundle.doc.title}
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
          <SectionRenderer doc={bundle.doc} section={bundle.section} index={1} />
        ) : null}
      </div>
    </div>
  );
}
