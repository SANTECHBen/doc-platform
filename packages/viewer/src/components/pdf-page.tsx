'use client';

// PdfPage — a single PDF page rendered as a canvas with an optional
// selectable text-layer overlay. Used by both the admin section editor (for
// text-range selection capture) and the PWA section renderer (for read-only
// display with highlight overlays).
//
// The component takes a pre-loaded PDFDocumentProxy (via the
// `usePdfDocument` hook in your app) so the same document can drive multiple
// pages without re-parsing the file.

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getPageDimensions,
  getPageTextLayer,
  renderPageToCanvas,
  rangeToPageOffsets,
  type PageDimensions,
  type PageTextLayer,
  type PDFDocumentProxy,
  type TextRun,
} from '../pdf-kernel.js';

export interface PdfPageProps {
  /** PDF document handle returned from `loadDocument`. */
  doc: PDFDocumentProxy;
  /** 1-indexed page number. */
  pageNumber: number;
  /** Render scale (1.0 = 72dpi). The component handles devicePixelRatio
   *  internally; pass the logical CSS scale you want. */
  scale?: number;
  /** Whether the text layer is rendered. Disabling improves perf on the PWA
   *  where we don't need text selection. Default: true. */
  enableTextLayer?: boolean;
  /** Whether the text layer is selectable (cursor + user-select). Default: false. */
  selectable?: boolean;
  /** Called when the user finishes a text selection inside the text layer.
   *  `null` is emitted when the selection is cleared or moves outside. */
  onSelectRange?: (range: {
    charStart: number;
    charEnd: number;
    text: string;
    pageText: string;
  } | null) => void;
  /** Children rendered absolutely-positioned over the page (highlight overlays). */
  children?: React.ReactNode;
  className?: string;
}

export function PdfPage(props: PdfPageProps): React.ReactElement {
  const {
    doc,
    pageNumber,
    scale = 1.4,
    enableTextLayer = true,
    selectable = false,
    onSelectRange,
    children,
    className,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);

  const [dims, setDims] = useState<PageDimensions | null>(null);
  const [textLayer, setTextLayer] = useState<PageTextLayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lazy-render gate. We always fetch dims so the placeholder reserves
  // the correct space (no layout jumps as the user scrolls), but the
  // expensive canvas render only fires when the page enters the
  // viewport. Without this, a 200-page PDF would render every page on
  // mount and overrun the browser's canvas memory budget — pages would
  // silently fail and images would be missing.
  const [shouldRender, setShouldRender] = useState(false);

  // Resolve dimensions and arm the IntersectionObserver as soon as we
  // know the page exists. Dims are cheap (just viewport metadata) so
  // doing them up-front for every page is fine; what we avoid is the
  // heavy rasterisation until the page is near the viewport.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDims(null);
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const cssDims = getPageDimensions(page, scale);
        if (cancelled) return;
        setDims(cssDims);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale]);

  // Watch the container's intersection with the viewport. Start
  // rendering ~600px before the page scrolls into view so the user
  // rarely sees the placeholder. Once a page has rendered we stop
  // observing — re-rendering on every scroll-out / scroll-in causes
  // visible flicker and burns CPU.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (shouldRender) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShouldRender(true);
            obs.disconnect();
            return;
          }
        }
      },
      { rootMargin: '600px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [shouldRender]);

  // Render the canvas + capture text layer once both (a) dimensions are
  // known and (b) the page has been scrolled into view at least once.
  useEffect(() => {
    if (!shouldRender) return;
    if (!dims) return;
    let cancelled = false;
    let activeRender: ReturnType<typeof renderPageToCanvas> | null = null;
    setTextLayer(null);

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        // Backing-store size at devicePixelRatio for crisp rendering.
        canvas.width = Math.floor(dims.width * dpr);
        canvas.height = Math.floor(dims.height * dpr);
        canvas.style.width = `${dims.width}px`;
        canvas.style.height = `${dims.height}px`;
        activeRender = renderPageToCanvas(page, canvas, scale * dpr);
        try {
          await activeRender.promise;
        } catch (renderErr) {
          // pdfjs throws a RenderingCancelledException on cancel(); that's
          // expected when the effect is being torn down before the previous
          // render finished, so swallow it. Only surface real errors.
          const name = (renderErr as { name?: string } | null)?.name;
          if (name !== 'RenderingCancelledException') throw renderErr;
          return;
        }
        if (cancelled) return;

        if (enableTextLayer) {
          const layer = await getPageTextLayer(page, scale);
          if (cancelled) return;
          setTextLayer(layer);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      // Cancel any in-flight render so a follow-up effect (e.g., scale
      // change from a ResizeObserver tick) doesn't race with us on the
      // same canvas. Without this, pdfjs throws "Cannot use the same
      // canvas during multiple render operations".
      activeRender?.cancel();
    };
  }, [doc, pageNumber, scale, enableTextLayer, shouldRender, dims]);

  // Selection capture — listen for `mouseup` inside the text layer and
  // resolve the current selection range to character offsets.
  const handleMouseUp = useCallback(() => {
    if (!onSelectRange || !textLayer) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      onSelectRange(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!textLayerRef.current?.contains(range.commonAncestorContainer)) {
      // Selection started/ended outside our text layer.
      return;
    }
    const offsets = rangeToPageOffsets(range, textLayer.runs);
    if (!offsets) {
      onSelectRange(null);
      return;
    }
    onSelectRange({
      charStart: offsets.charStart,
      charEnd: offsets.charEnd,
      text: textLayer.pageText.slice(offsets.charStart, offsets.charEnd),
      pageText: textLayer.pageText,
    });
  }, [onSelectRange, textLayer]);

  if (error) {
    return (
      <div className={`pdf-page-error ${className ?? ''}`} role="alert">
        Failed to render page {pageNumber}: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`pdf-page ${className ?? ''}`}
      style={{
        position: 'relative',
        width: dims ? `${dims.width}px` : undefined,
        height: dims ? `${dims.height}px` : undefined,
        userSelect: selectable ? 'text' : 'none',
      }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {enableTextLayer && textLayer ? (
        <div
          ref={textLayerRef}
          className="pdf-text-layer"
          onMouseUp={handleMouseUp}
          style={{
            position: 'absolute',
            inset: 0,
            color: 'transparent',
            cursor: selectable ? 'text' : 'default',
            // Selection highlights need a visible background to show through.
            // We don't paint glyphs, just position invisible spans so DOM
            // selection lands on the right characters.
            pointerEvents: selectable ? 'auto' : 'none',
          }}
        >
          {textLayer.runs.map((run, idx) => (
            <TextRunSpan key={idx} run={run} index={idx} />
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function TextRunSpan({ run, index }: { run: TextRun; index: number }): React.ReactElement {
  return (
    <span
      data-run-index={index}
      style={{
        position: 'absolute',
        left: `${run.x}px`,
        top: `${run.y}px`,
        width: `${run.width}px`,
        height: `${run.height}px`,
        whiteSpace: 'pre',
        // Native browser selection paints over this span; we set transparent
        // text so glyphs from the canvas show through but selection is on
        // the right run.
        color: 'transparent',
        // Align baseline with the canvas glyphs.
        lineHeight: `${run.height}px`,
        fontSize: `${run.height}px`,
      }}
    >
      {run.text}
    </span>
  );
}
