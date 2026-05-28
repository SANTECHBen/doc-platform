'use client';

// usePdfSearch — drives the FramedPdf "Find" bar.
//
// PDFs render to canvas with the text layer disabled (see framed-pdf.tsx), so
// the browser's native Ctrl+F has nothing to search. This hook builds its own
// search index by extracting the text layer for every page (once, lazily, the
// first time the user opens the find bar) and then locating a query across all
// pages the way Acrobat does.
//
// Coordinate note: we extract text at scale 1, so every run's x/y/width/height
// is in PDF points. The caller multiplies by the current render scale when
// painting highlight rects — that keeps the index scale-independent so a
// resize/fullscreen toggle never forces a re-extract.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getPageTextLayer,
  findAllMatches,
  type PDFDocumentProxy,
  type TextRun,
} from '@platform/viewer';

export interface PdfSearchMatch {
  pageNumber: number;
  charStart: number;
  charEnd: number;
}

interface PageIndexEntry {
  pageText: string;
  runs: TextRun[];
}

export interface PdfSearchState {
  query: string;
  setQuery: (q: string) => void;
  caseSensitive: boolean;
  toggleCaseSensitive: () => void;
  wholeWord: boolean;
  toggleWholeWord: () => void;

  matches: PdfSearchMatch[];
  activeIndex: number; // -1 when there are no matches
  goNext: () => void;
  goPrev: () => void;

  /** page number -> text runs (scale-1 coords) for rect computation. */
  runsByPage: Map<number, TextRun[]>;

  indexing: boolean;
  indexedCount: number;
  totalPages: number;
  /** True once at least one page yielded extractable text. */
  hasText: boolean;
  /** True when matches were capped at MAX_MATCHES. */
  truncated: boolean;
}

// Cap matches so a single-letter query on a 300-page manual can't allocate
// hundreds of thousands of highlight rects and lock the main thread. Acrobat
// caps its results similarly; we surface the cap via `truncated`.
const MAX_MATCHES = 1000;
// Extract a handful of pages at a time. pdfjs serializes work on its worker
// anyway; this just bounds peak memory from holding many getTextContent
// promises in flight on huge documents.
const INDEX_CONCURRENCY = 6;
const QUERY_DEBOUNCE_MS = 140;

export function usePdfSearch(
  pdf: PDFDocumentProxy | null,
  active: boolean,
): PdfSearchState {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  // The index accumulates in a ref (not state) so appending a page doesn't
  // clone a Map on every completion. `indexVersion` bumps to signal consumers
  // (the match-recompute effect, the memos) that new pages are available.
  const indexRef = useRef<Map<number, PageIndexEntry>>(new Map());
  const startedRef = useRef(false);
  const [indexVersion, setIndexVersion] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [indexedCount, setIndexedCount] = useState(0);

  const totalPages = pdf?.numPages ?? 0;

  // Reset everything when the document changes.
  useEffect(() => {
    indexRef.current = new Map();
    startedRef.current = false;
    setIndexVersion(0);
    setIndexedCount(0);
    setIndexing(false);
  }, [pdf]);

  // Build the index lazily, the first time the find bar is opened for this
  // document. Bounded-concurrency worker pool over all pages.
  useEffect(() => {
    if (!pdf || !active || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    setIndexing(true);

    void (async () => {
      const total = pdf.numPages;
      let nextPage = 1;
      let completed = 0;

      const runWorker = async (): Promise<void> => {
        while (!cancelled) {
          const pageNumber = nextPage++;
          if (pageNumber > total) return;
          try {
            const page = await pdf.getPage(pageNumber);
            const layer = await getPageTextLayer(page, 1);
            if (cancelled) return;
            indexRef.current.set(pageNumber, {
              pageText: layer.pageText,
              runs: layer.runs,
            });
          } catch {
            // A single page failing to extract (corrupt stream, unusual
            // encoding) shouldn't stall search on the rest of the document.
            if (cancelled) return;
            indexRef.current.set(pageNumber, { pageText: '', runs: [] });
          }
          completed++;
          // Coalesce re-renders: surface progress roughly per batch plus a
          // final update, instead of once per page on a 300-page doc.
          if (completed % INDEX_CONCURRENCY === 0 || completed === total) {
            setIndexedCount(completed);
            setIndexVersion((v) => v + 1);
          }
        }
      };

      const pool = Array.from(
        { length: Math.min(INDEX_CONCURRENCY, Math.max(1, total)) },
        () => runWorker(),
      );
      await Promise.all(pool);
      if (cancelled) return;
      setIndexedCount(total);
      setIndexing(false);
      setIndexVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [pdf, active]);

  // ---- Matching -----------------------------------------------------------

  const [matches, setMatches] = useState<PdfSearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Remembers the currently-active match by identity so we can keep the user
  // anchored on it when the match set is recomputed (e.g. more pages finish
  // indexing while they're reading a hit on page 1).
  const activeMatchRef = useRef<PdfSearchMatch | null>(null);
  useEffect(() => {
    activeMatchRef.current =
      activeIndex >= 0 && activeIndex < matches.length ? matches[activeIndex]! : null;
  }, [activeIndex, matches]);

  useEffect(() => {
    if (!query) {
      setMatches([]);
      setTruncated(false);
      setActiveIndex(-1);
      return;
    }
    const handle = setTimeout(() => {
      const found: PdfSearchMatch[] = [];
      let didTruncate = false;
      const pageNumbers = Array.from(indexRef.current.keys()).sort((a, b) => a - b);
      for (const pn of pageNumbers) {
        if (found.length >= MAX_MATCHES) {
          didTruncate = true;
          break;
        }
        const entry = indexRef.current.get(pn);
        if (!entry || !entry.pageText) continue;
        const pageMatches = findAllMatches(entry.pageText, query, {
          caseSensitive,
          wholeWord,
          limit: MAX_MATCHES - found.length,
        });
        for (const m of pageMatches) {
          found.push({ pageNumber: pn, charStart: m.charStart, charEnd: m.charEnd });
        }
        if (found.length >= MAX_MATCHES) didTruncate = true;
      }

      setMatches(found);
      setTruncated(didTruncate);

      // Preserve the active match across recomputes; otherwise land on the
      // first hit (Acrobat scrolls to the first result as you type).
      const prev = activeMatchRef.current;
      let next = found.length > 0 ? 0 : -1;
      if (prev) {
        const idx = found.findIndex(
          (m) => m.pageNumber === prev.pageNumber && m.charStart === prev.charStart,
        );
        if (idx >= 0) next = idx;
      }
      setActiveIndex(next);
    }, QUERY_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [query, caseSensitive, wholeWord, indexVersion]);

  const goNext = useCallback(() => {
    setActiveIndex((i) => (matches.length === 0 ? -1 : i < 0 ? 0 : (i + 1) % matches.length));
  }, [matches.length]);

  const goPrev = useCallback(() => {
    setActiveIndex((i) =>
      matches.length === 0 ? -1 : i <= 0 ? matches.length - 1 : i - 1,
    );
  }, [matches.length]);

  const toggleCaseSensitive = useCallback(() => setCaseSensitive((b) => !b), []);
  const toggleWholeWord = useCallback(() => setWholeWord((b) => !b), []);

  const runsByPage = useMemo(() => {
    const m = new Map<number, TextRun[]>();
    for (const [pn, entry] of indexRef.current) m.set(pn, entry.runs);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexVersion]);

  const hasText = useMemo(() => {
    for (const entry of indexRef.current.values()) {
      if (entry.pageText.trim().length > 0) return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexVersion]);

  return {
    query,
    setQuery,
    caseSensitive,
    toggleCaseSensitive,
    wholeWord,
    toggleWholeWord,
    matches,
    activeIndex,
    goNext,
    goPrev,
    runsByPage,
    indexing,
    indexedCount,
    totalPages,
    hasText,
    truncated,
  };
}
