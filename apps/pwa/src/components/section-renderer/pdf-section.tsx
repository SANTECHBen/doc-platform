'use client';

// PDF section renderer — for both page_range and PDF-source text_range
// sections. Loads the PDF lazily via @platform/viewer and renders just the
// pages the section points at.
//
// page_range: renders pageStart..pageEnd inline.
// text_range (PDF): renders the textPageHint page with a highlight overlay
//   on the matched excerpt; falls back to no-highlight if the locator can't
//   find a match in the rendered page text.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getPageDimensions,
  loadDocument,
  PdfPage,
  SectionHighlight,
  locateExcerptInPage,
  rectsForSpan,
  type PDFDocumentProxy,
} from '@platform/viewer';
import type { DocumentBody, PwaDocumentSection } from '@/lib/api';

// pdfjs worker URL is set inside @platform/viewer's pdf-kernel — defaults
// to a CDN that ships pdfjs-dist's worker. Host apps can override via
// setupPdfjsWorker(url) if they want to self-host.

export function PdfSection({
  doc,
  section,
}: {
  doc: DocumentBody;
  section: PwaDocumentSection;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  // Width of the first page at scale 1, in pdfjs CSS pixels (= PDF points).
  // Drives the fit-to-container scale below.
  const [intrinsicWidth, setIntrinsicWidth] = useState<number | null>(null);

  // R2's public bucket has CORS configured for the PWA origin so pdfjs can
  // fetch directly from the edge CDN with native HTTP range support — much
  // faster than routing through the API proxy. If you ever change buckets
  // or origins, verify CORS via:
  //   curl -I -H "Origin: <pwa-origin>" <r2-public-url>
  // and look for Access-Control-Allow-Origin in the response.
  useEffect(() => {
    if (!doc.fileUrl) {
      setError('PDF file URL is missing.');
      return;
    }
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setIntrinsicWidth(null);
    loadDocument({ source: doc.fileUrl })
      .then(async (p) => {
        if (cancelled) {
          void p.destroy();
          return;
        }
        loaded = p;
        setPdf(p);
        try {
          const first = await p.getPage(1);
          if (cancelled) return;
          const dims = getPageDimensions(first, 1);
          setIntrinsicWidth(dims.width);
        } catch {
          if (!cancelled) setIntrinsicWidth(612);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [doc.fileUrl]);

  // Track container width so PdfPage can render at fit-to-screen scale on
  // any device. Hardcoding scale=1.4 made section pages render ~856px wide
  // on phones and rely on the global `max-width: 100%` rule to clamp them,
  // which (a) only constrained width, leaving the explicit canvas height
  // unchanged → distorted aspect ratio, and (b) wasn't crisp because the
  // browser was downscaling a too-large canvas instead of pdfjs rendering
  // at the right size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);

  const targetScale = useMemo(() => {
    if (!containerWidth || !intrinsicWidth) return 1.0;
    const padding = 4; // small breathing room so a 1px subpixel doesn't clip
    const usable = Math.max(120, containerWidth - padding);
    const s = usable / intrinsicWidth;
    // Floor at 0.5 keeps the canvas readable on a tiny phone; ceiling at 4.0
    // keeps oversize schematics from blowing past a sane render budget.
    // CRITICALLY do not floor at 1.0 — that prevents fitting on any phone
    // narrower than the page's intrinsic width (which is ~every phone for a
    // US-Letter manual) and causes the right edge to clip off-screen.
    return Math.min(4.0, Math.max(0.5, s));
  }, [containerWidth, intrinsicWidth]);

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
    <div ref={containerRef} className="flex flex-col gap-3">
      {pages.map((pageNumber) => (
        <PdfSectionPage
          key={pageNumber}
          pdf={pdf}
          pageNumber={pageNumber}
          section={section}
          scale={targetScale}
        />
      ))}
    </div>
  );
}

function PdfSectionPage({
  pdf,
  pageNumber,
  section,
  scale,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  section: PwaDocumentSection;
  scale: number;
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
        // Match the page's render scale so highlight rects align with the
        // canvas. Using a hardcoded scale here would offset the highlight
        // overlay whenever the canvas was rendered at a different zoom.
        const layer = await getPageTextLayer(page, scale);
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
  }, [pdf, pageNumber, section, scale]);

  // Compute the Y crop bounds for THIS page. startY applies only to the
  // first page of the section's range; endY only to the last page. Pages
  // in between (or the same page when start === end) get both.
  const isFirstPage = pageNumber === (section.pageStart ?? 1);
  const isLastPage = pageNumber === (section.pageEnd ?? section.pageStart ?? 1);
  const cropTop = isFirstPage ? section.startY : null;
  const cropBottom = isLastPage ? section.endY : null;
  const hasCrop = cropTop != null || cropBottom != null;

  // CSS clip-path: keep [topPct..bottomPct] vertical band, hide the rest.
  // top pct = 100 * cropTop, bottom pct = 100 * cropBottom (default 100).
  const topPct = (cropTop ?? 0) * 100;
  const bottomPct = (cropBottom ?? 1) * 100;
  const cropStyle: React.CSSProperties = hasCrop
    ? {
        clipPath: `inset(${topPct}% 0 ${100 - bottomPct}% 0)`,
        WebkitClipPath: `inset(${topPct}% 0 ${100 - bottomPct}% 0)`,
        // Negative-margin trick: collapse the hidden vertical strips so the
        // visible band sits flush in its container without empty space.
        marginTop: `-${topPct}%`,
        marginBottom: `-${100 - bottomPct}%`,
      }
    : {};

  return (
    <div
      style={{ ...cropStyle, maxWidth: '100%', overflow: 'hidden' }}
    >
      <PdfPage doc={pdf} pageNumber={pageNumber} scale={scale} enableTextLayer={false}>
        {highlightRects.length > 0 && <SectionHighlight rects={highlightRects} />}
      </PdfPage>
    </div>
  );
}
