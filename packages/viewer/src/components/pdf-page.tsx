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

  // Render the canvas + capture text layer whenever inputs change.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDims(null);
    setTextLayer(null);

    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
        const cssDims = getPageDimensions(page, scale);
        if (cancelled) return;
        setDims(cssDims);

        const canvas = canvasRef.current;
        if (!canvas) return;
        // Backing-store size at devicePixelRatio for crisp rendering.
        canvas.width = Math.floor(cssDims.width * dpr);
        canvas.height = Math.floor(cssDims.height * dpr);
        canvas.style.width = `${cssDims.width}px`;
        canvas.style.height = `${cssDims.height}px`;
        await renderPageToCanvas(page, canvas, scale * dpr);
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
    };
  }, [doc, pageNumber, scale, enableTextLayer]);

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
