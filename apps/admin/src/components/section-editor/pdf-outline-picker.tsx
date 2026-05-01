'use client';

// Loads the PDF's built-in outline (TOC bookmarks) and lets the admin
// click an entry to auto-populate pageStart/pageEnd/startY/endY for the
// current section. The chosen entry's destination becomes the section's
// start; the NEXT outline entry's destination becomes the end.
//
// Most maintenance manuals ship with a TOC outline so this is much faster
// than eyeballing percentages on the slider. Falls back gracefully when
// the PDF has no outline (rare but possible — admin uses the manual
// page/Y inputs as before).

import { useEffect, useState } from 'react';
import { ChevronRight, ListTree } from 'lucide-react';
import { setupPdfjsWorker, loadDocument, getOutlineEntries, type OutlineEntry } from '@platform/viewer';

let workerConfigured = false;
function ensureWorker() {
  if (workerConfigured) return;
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    setupPdfjsWorker(url);
    workerConfigured = true;
  } catch {
    /* fall through */
  }
}

export function PdfOutlinePicker({
  fileUrl,
  onPick,
}: {
  fileUrl: string;
  onPick: (v: {
    title: string;
    pageStart: number;
    pageEnd: number;
    startY: number | null;
    endY: number | null;
  }) => void;
}) {
  const [entries, setEntries] = useState<OutlineEntry[] | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ensureWorker();
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const pdf = await loadDocument({ source: fileUrl });
        const [list] = await Promise.all([getOutlineEntries(pdf)]);
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        setTotalPages(pdf.numPages);
        setEntries(list);
        void pdf.destroy();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl]);

  function handlePick(idx: number) {
    if (!entries) return;
    const entry = entries[idx];
    if (!entry || entry.pageNumber == null) return;

    // Find the next entry (any depth) that has a resolvable page. Its start
    // is our end. If no next entry exists, end = end-of-document.
    let next: OutlineEntry | null = null;
    for (let i = idx + 1; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.pageNumber != null) {
        next = e;
        break;
      }
    }

    const pageStart = entry.pageNumber;
    const startY = entry.yFraction;
    let pageEnd: number;
    let endY: number | null;
    if (next && next.pageNumber != null) {
      pageEnd = next.pageNumber;
      endY = next.yFraction;
      // If the next entry starts at the very top of its page (yFraction ≈ 0),
      // back up to the previous page's end so we don't render an empty strip.
      if (endY != null && endY < 0.01 && pageEnd > pageStart) {
        pageEnd = pageEnd - 1;
        endY = null; // render full last page
      }
    } else {
      // Last entry — extend to end of doc.
      pageEnd = totalPages;
      endY = null;
    }

    // Same-page adjustment: if start and end are on the same page, both
    // crops apply to it. Make sure startY < endY.
    if (pageStart === pageEnd && startY != null && endY != null && startY >= endY) {
      // Fall back to start-of-page → end-of-page on this single page.
      onPick({ title: entry.title, pageStart, pageEnd, startY: null, endY: null });
      return;
    }

    onPick({ title: entry.title, pageStart, pageEnd, startY, endY });
  }

  if (loading) {
    return (
      <div className="rounded border border-line-subtle bg-surface p-3 text-sm text-ink-tertiary">
        Loading PDF outline…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded border border-signal-warn/40 bg-signal-warn/10 p-3 text-xs text-signal-warn">
        Outline unavailable: {error}
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <div className="rounded border border-line-subtle bg-surface p-3 text-xs text-ink-tertiary">
        This PDF has no built-in outline. Use the page numbers + Y sliders below.
      </div>
    );
  }

  return (
    <div className="rounded border border-line-subtle bg-surface">
      <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-2 text-xs font-medium text-ink-secondary">
        <ListTree size={14} strokeWidth={2} />
        Pick from PDF outline ({entries.length})
      </div>
      <ul className="max-h-64 overflow-y-auto py-1">
        {entries.map((e, idx) => (
          <li key={idx}>
            <button
              type="button"
              onClick={() => handlePick(idx)}
              disabled={e.pageNumber == null}
              className={`group flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-raised ${
                e.pageNumber == null ? 'cursor-not-allowed opacity-40' : ''
              }`}
              style={{ paddingLeft: `${12 + e.depth * 14}px` }}
              title={
                e.pageNumber == null
                  ? "This entry has no page destination — pdfjs can't resolve it"
                  : `Picks page ${e.pageNumber} → next outline entry`
              }
            >
              <ChevronRight
                size={12}
                strokeWidth={2}
                className="shrink-0 text-ink-tertiary group-hover:text-ink-primary"
              />
              <span className="flex-1 truncate text-ink-primary">{e.title}</span>
              <span className="shrink-0 font-mono text-xs text-ink-tertiary">
                {e.pageNumber != null ? `p.${e.pageNumber}` : '—'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="border-t border-line-subtle px-3 py-1.5 text-xs text-ink-tertiary">
        Click an entry to set page range + Y crops automatically. Adjust below if needed.
      </p>
    </div>
  );
}
