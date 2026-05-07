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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Maximize2, Minimize2 } from 'lucide-react';
import {
  loadDocument,
  PdfPage,
  type PDFDocumentProxy,
} from '@platform/viewer';

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
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Load the PDF once. R2's public bucket already has CORS configured for
  // the PWA origin so pdfjs can stream pages with HTTP range requests.
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setError(null);
    setPdf(null);
    loadDocument({ source: url })
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

  // PDF pages are typically 612pt wide (US letter) at scale 1. We aim to
  // fit the container width with a max scale of 2.0 (so on desktop we don't
  // upscale a small PDF to fuzzy size). Account for ~16px of horizontal
  // padding so pages don't kiss the edges.
  const targetScale = useMemo(() => {
    if (!containerWidth) return 1.0;
    const padding = 16;
    const usable = Math.max(280, containerWidth - padding);
    // Approximate raw page width at scale 1 — actual pages can vary; pdfjs
    // will render at this scale and we let the canvas drive layout.
    const baseWidth = 612;
    const s = usable / baseWidth;
    return Math.min(2.5, Math.max(0.5, s));
  }, [containerWidth]);

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? 'flex h-screen w-screen flex-col bg-surface-base'
          : 'flex h-full w-full flex-col bg-surface-elevated'
      }
    >
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
        {!error && !pdf && (
          <div className="flex h-full items-center justify-center text-sm text-ink-tertiary">
            Loading PDF…
          </div>
        )}
        {pdf && (
          <div className="flex flex-col items-center gap-3 px-2 py-3">
            {pageNumbers.map((n) => (
              <div
                key={n}
                className="overflow-hidden rounded border border-line bg-white shadow-sm"
              >
                <PdfPage
                  doc={pdf}
                  pageNumber={n}
                  scale={targetScale}
                  enableTextLayer={false}
                />
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute right-3 top-3 inline-flex items-center gap-2 rounded bg-surface-base/90 px-3 py-1.5 text-xs font-medium text-ink-primary shadow-md backdrop-blur transition hover:bg-surface-raised"
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

      <div className="flex shrink-0 items-center justify-between border-t border-line-subtle bg-surface-raised px-3 py-2 text-xs text-ink-tertiary">
        <span className="truncate">{title}</span>
        <a
          href={url}
          download={filename ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="ml-3 inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 transition hover:bg-surface-elevated hover:text-ink-primary"
        >
          <Download size={12} strokeWidth={2} />
          Download {filename ?? 'PDF'}
        </a>
      </div>
    </div>
  );
}
