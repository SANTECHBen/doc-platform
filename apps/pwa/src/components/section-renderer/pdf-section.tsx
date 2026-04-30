'use client';

// PDF section renderer — for both page_range and PDF-source text_range
// sections. Loads the PDF lazily via @platform/viewer and renders just the
// pages the section points at.
//
// page_range: renders pageStart..pageEnd inline.
// text_range (PDF): renders the textPageHint page with a highlight overlay
//   on the matched excerpt; falls back to no-highlight if the locator can't
//   find a match in the rendered page text.

import { useEffect, useMemo, useState } from 'react';
import {
  loadDocument,
  PdfPage,
  SectionHighlight,
  setupPdfjsWorker,
  locateExcerptInPage,
  rectsForSpan,
  type PDFDocumentProxy,
} from '@platform/viewer';
import type { DocumentBody, PwaDocumentSection } from '@/lib/api';

// Configure pdfjs worker once. Vite/webpack/turbopack support `?url` imports
// for worker files; in Next 15 we use a runtime URL relative to the public
// CDN (pdfjs-dist ships the worker as part of the package).
let workerConfigured = false;
function ensureWorker() {
  if (workerConfigured) return;
  if (typeof window === 'undefined') return;
  // Use the worker bundled with pdfjs-dist via a static import URL. Falls
  // back to in-thread rendering if the URL is unreachable.
  try {
    const url = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    setupPdfjsWorker(url);
    workerConfigured = true;
  } catch {
    /* fall through — kernel uses in-thread rendering as fallback */
  }
}

export function PdfSection({
  doc,
  section,
}: {
  doc: DocumentBody;
  section: PwaDocumentSection;
}): React.ReactElement {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ensureWorker();
    if (!doc.fileUrl) {
      setError('PDF file URL is missing.');
      return;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    loadDocument({ source: doc.fileUrl })
      .then((p) => {
        if (cancelled) {
          void p.destroy();
          return;
        }
        loaded = p;
        setPdf(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [doc.fileUrl]);

  const pages = useMemo<number[]>(() => {
    if (section.kind === 'page_range') {
      const out: number[] = [];
      const start = section.pageStart ?? 1;
      const end = section.pageEnd ?? start;
      for (let p = start; p <= end; p++) out.push(p);
      return out;
    }
    // text_range on PDF — render only the hint page (or page 1 fallback).
    return [section.textPageHint ?? 1];
  }, [section]);

  if (error) {
    return (
      <p className="px-4 text-xs text-signal-fault">Failed to render PDF: {error}</p>
    );
  }

  if (!pdf) {
    return <p className="px-4 text-sm text-ink-tertiary">Loading PDF…</p>;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {pages.map((pageNumber) => (
        <PdfSectionPage
          key={pageNumber}
          pdf={pdf}
          pageNumber={pageNumber}
          section={section}
        />
      ))}
    </div>
  );
}

function PdfSectionPage({
  pdf,
  pageNumber,
  section,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  section: PwaDocumentSection;
}): React.ReactElement {
  // For text_range, we need the page's text-layer to compute highlight rects.
  // We pull this out of PdfPage's render via a child overlay that uses the
  // same getPageTextLayer call. To keep the code simple, we forward to a
  // local state via the PdfPage's `enableTextLayer` and a callback hooked in
  // by re-rendering the overlay on demand. For now, render PdfPage with
  // text-layer disabled (no selection needed) and rely on excerpt-locator
  // against the text-layer for the highlight.
  const [highlightRects, setHighlightRects] = useState<
    Array<{ x: number; y: number; width: number; height: number }>
  >([]);

  useEffect(() => {
    if (section.kind !== 'text_range') {
      setHighlightRects([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { getPageTextLayer } = await import('@platform/viewer');
        const page = await pdf.getPage(pageNumber);
        const layer = await getPageTextLayer(page, 1.4);
        if (cancelled) return;
        const located = locateExcerptInPage({
          pageText: layer.pageText,
          excerpt: section.anchorExcerpt ?? '',
          contextBefore: section.anchorContextBefore,
          contextAfter: section.anchorContextAfter,
        });
        if (!located) {
          setHighlightRects([]);
          return;
        }
        const rects = rectsForSpan(located.charStart, located.charEnd, layer.runs);
        setHighlightRects(rects);
      } catch {
        // Swallow — the page still renders, just without a highlight.
        if (!cancelled) setHighlightRects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, section]);

  return (
    <PdfPage doc={pdf} pageNumber={pageNumber} scale={1.4} enableTextLayer={false}>
      {highlightRects.length > 0 && <SectionHighlight rects={highlightRects} />}
    </PdfPage>
  );
}
