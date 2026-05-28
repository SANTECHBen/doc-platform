'use client';

// FramedPdf — renders a PDF as canvas pages via @platform/viewer (pdfjs).
//
// Why not <iframe src=pdf>? iOS Safari refuses to render PDFs in iframes —
// you get a broken-looking thumbnail and "tap to open" behavior, which is
// what techs were reporting as a "shrunk and distorted" PDF. pdfjs renders
// every page to a canvas at devicePixelRatio so it's crisp on retina, scrolls
// natively, and works identically on desktop and mobile.
//
// The component is responsible for its own scrolling — the parent (a
// `.doc-overlay-frame`) sizes us to the remaining viewport and we render
// pages stacked vertically. Pages are width-fit to the container.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Maximize2, Minimize2, Search } from 'lucide-react';
import {
  getPageDimensions,
  loadDocument,
  PdfPage,
  rectsForSpan,
  type HighlightRect,
  type PDFDocumentProxy,
} from '@platform/viewer';
import { usePdfSearch } from './use-pdf-search';
import { PdfFindBar } from './pdf-find-bar';

export function FramedPdf({
  url,
  filename,
  title,
}: {
  url: string;
  filename: string | null | undefined;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  // Width of the FIRST page at scale 1, in pdfjs CSS pixels (= PDF points).
  // We can't assume US Letter — schematics are routinely Tabloid (792pt),
  // Arch B (432×648pt), or custom. Reading the real intrinsic width keeps
  // every page kind fitting the container instead of drawing tiny.
  const [intrinsicWidth, setIntrinsicWidth] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Load the PDF once. R2's public bucket already has CORS configured for
  // the PWA origin so pdfjs can stream pages with HTTP range requests.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setError(null);
    setPdf(null);
    setIntrinsicWidth(null);
    loadDocument({ source: url })
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
          // Fall back to a conservative US-letter assumption — better
          // than rendering nothing.
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
  }, [url]);

  // Watch the scrollable area's clientWidth so PdfPage can render at a
  // scale that fits horizontally on whatever device we're on. ResizeObserver
  // catches rotation, fullscreen toggle, and admin sidebar collapse.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);

  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      window.open(url, '_blank', 'noreferrer');
    }
  }

  const pageNumbers = useMemo(() => {
    if (!pdf) return [];
    return Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  }, [pdf]);

  // Fit the page to the available width using its actual intrinsic width
  // (read from page 1 above). The 16px subtraction accounts for the
  // gutters around each page; the floor at 0.5/ceiling at 4.0 keeps tiny
  // forms from upscaling to fuzz and oversize schematics from blowing past
  // a sane render budget on lower-end phones.
  const targetScale = useMemo(() => {
    if (!containerWidth || !intrinsicWidth) return 1.0;
    const padding = 16;
    const usable = Math.max(280, containerWidth - padding);
    const s = usable / intrinsicWidth;
    return Math.min(4.0, Math.max(0.5, s));
  }, [containerWidth, intrinsicWidth]);

  // ---- Find ("Ctrl+F") ----------------------------------------------------

  const [searchOpen, setSearchOpen] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const search = usePdfSearch(pdf, searchOpen);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setFocusTick((t) => t + 1);
  }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Ctrl/Cmd+F opens our find bar instead of the browser's (which can't see
  // canvas-rendered text). Scoped to this component's lifetime — FramedPdf is
  // only mounted while a PDF is open in the Library.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openSearch();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openSearch]);

  // Compute highlight rects per page in scale-1 (PDF point) space; the overlay
  // multiplies by targetScale at render time. Memoized on the match set so a
  // resize doesn't recompute rects, only re-scales them.
  const rectsByPage = useMemo(() => {
    const out = new Map<number, { matchIndex: number; rects: HighlightRect[] }[]>();
    if (!searchOpen) return out;
    search.matches.forEach((m, idx) => {
      const runs = search.runsByPage.get(m.pageNumber);
      if (!runs || runs.length === 0) return;
      const rects = rectsForSpan(m.charStart, m.charEnd, runs);
      if (rects.length === 0) return;
      const arr = out.get(m.pageNumber);
      if (arr) arr.push({ matchIndex: idx, rects });
      else out.set(m.pageNumber, [{ matchIndex: idx, rects }]);
    });
    return out;
  }, [searchOpen, search.matches, search.runsByPage]);

  // Wrapper elements per page so we can scroll a match into view even before
  // its canvas has lazily rendered (dimensions resolve up front).
  const pageElRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastScrolledRef = useRef<string | null>(null);

  // Scroll the active match to the vertical center. Keyed on match identity so
  // it fires when the user navigates or the query changes, but NOT on every
  // resize tick (same match → same key → skip).
  useEffect(() => {
    if (!searchOpen) {
      lastScrolledRef.current = null;
      return;
    }
    const idx = search.activeIndex;
    if (idx < 0 || idx >= search.matches.length) return;
    const m = search.matches[idx]!;
    const key = `${m.pageNumber}:${m.charStart}`;
    if (lastScrolledRef.current === key) return;

    const scrollEl = scrollRef.current;
    const pageEl = pageElRefs.current.get(m.pageNumber);
    if (!scrollEl || !pageEl) return;
    lastScrolledRef.current = key;

    let rectY = 0;
    let rectH = 14;
    const runs = search.runsByPage.get(m.pageNumber);
    if (runs) {
      const rects = rectsForSpan(m.charStart, m.charEnd, runs);
      if (rects.length > 0) {
        rectY = rects[0]!.y;
        rectH = rects[0]!.height;
      }
    }

    const pageRect = pageEl.getBoundingClientRect();
    const scRect = scrollEl.getBoundingClientRect();
    const displayY = rectY * targetScale;
    const target =
      scrollEl.scrollTop +
      (pageRect.top - scRect.top) +
      displayY -
      scRect.height / 2 +
      (rectH * targetScale) / 2;
    scrollEl.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [searchOpen, search.activeIndex, search.matches, search.runsByPage, targetScale]);

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? 'flex h-screen w-screen flex-col bg-surface-base'
          : 'flex h-full w-full flex-col bg-surface-elevated'
      }
    >
      {searchOpen && (
        <PdfFindBar
          query={search.query}
          onQueryChange={search.setQuery}
          matchCount={search.matches.length}
          activeIndex={search.activeIndex}
          truncated={search.truncated}
          indexing={search.indexing}
          indexedCount={search.indexedCount}
          totalPages={search.totalPages}
          hasText={search.hasText}
          caseSensitive={search.caseSensitive}
          onToggleCase={search.toggleCaseSensitive}
          wholeWord={search.wholeWord}
          onToggleWholeWord={search.toggleWholeWord}
          onNext={search.goNext}
          onPrev={search.goPrev}
          onClose={closeSearch}
          focusTick={focusTick}
        />
      )}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto"
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        {error && (
          <p className="m-4 rounded border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
            Failed to render PDF: {error}
          </p>
        )}
        {!error && (!pdf || !intrinsicWidth) && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand" />
            <p className="text-base font-medium text-ink-primary">Loading PDF</p>
            <p className="text-sm text-ink-secondary">
              First page may take a few seconds on slow connections.
            </p>
          </div>
        )}
        {pdf && intrinsicWidth && (
          <div className="flex flex-col items-center gap-3 px-2 py-3">
            {pageNumbers.map((n) => {
              const groups = rectsByPage.get(n);
              return (
                <div
                  key={n}
                  ref={(el) => {
                    if (el) pageElRefs.current.set(n, el);
                    else pageElRefs.current.delete(n);
                  }}
                  className="overflow-hidden rounded border border-line bg-white shadow-sm"
                >
                  <PdfPage doc={pdf} pageNumber={n} scale={targetScale} enableTextLayer={false}>
                    {searchOpen && groups && groups.length > 0 ? (
                      <SearchHighlights
                        groups={groups}
                        activeMatchIndex={search.activeIndex}
                        scale={targetScale}
                      />
                    ) : null}
                  </PdfPage>
                </div>
              );
            })}
          </div>
        )}

        <div className="absolute right-3 top-3 flex items-center gap-2">
          {!searchOpen && (
            <button
              type="button"
              onClick={openSearch}
              className="inline-flex items-center gap-2 rounded bg-surface-base/90 px-3 py-1.5 text-xs font-medium text-ink-primary shadow-md backdrop-blur transition hover:bg-surface-raised"
              aria-label="Find in document"
            >
              <Search size={14} strokeWidth={2} /> Find
            </button>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            className="inline-flex items-center gap-2 rounded bg-surface-base/90 px-3 py-1.5 text-xs font-medium text-ink-primary shadow-md backdrop-blur transition hover:bg-surface-raised"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              <>
                <Minimize2 size={14} strokeWidth={2} /> Exit fullscreen
              </>
            ) : (
              <>
                <Maximize2 size={14} strokeWidth={2} /> Fullscreen
              </>
            )}
          </button>
        </div>
      </div>

      <div className="framed-pdf-footer">
        <span className="framed-pdf-title">{title}</span>
        <a
          href={url}
          download={filename ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="framed-pdf-download"
        >
          <Download size={12} strokeWidth={2} />
          <span>Download</span>
        </a>
      </div>
    </div>
  );
}

// Paints search-match highlight boxes over a single page. Rects arrive in
// scale-1 (PDF point) space; we multiply by the current render scale here so
// the overlay tracks the page without the search index re-extracting on
// resize. The active match gets a distinct fill.
function SearchHighlights({
  groups,
  activeMatchIndex,
  scale,
}: {
  groups: { matchIndex: number; rects: HighlightRect[] }[];
  activeMatchIndex: number;
  scale: number;
}) {
  return (
    <div
      className="pdf-search-highlights"
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      {groups.map(({ matchIndex, rects }) => {
        const active = matchIndex === activeMatchIndex;
        return rects.map((r, i) => (
          <div
            key={`${matchIndex}-${i}`}
            className={active ? 'pdf-search-hit pdf-search-hit--active' : 'pdf-search-hit'}
            style={{
              left: `${r.x * scale}px`,
              top: `${r.y * scale}px`,
              width: `${r.width * scale}px`,
              height: `${r.height * scale}px`,
            }}
          />
        ));
      })}
    </div>
  );
}
