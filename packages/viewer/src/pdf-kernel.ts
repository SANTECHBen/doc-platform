// PDF rendering kernel — a thin SSR-safe wrapper around pdfjs-dist that the
// admin section editor and the PWA section renderer both consume.
//
// pdfjs-dist must NEVER be imported at module top-level because it touches
// `window` and `DOMMatrix` synchronously and will blow up under Next's
// node-render pass. Everything here is gated behind `getPdfjs()` which lazy-
// imports the lib in browser contexts only.
//
// Worker setup: the host app should call `setupPdfjsWorker(url)` once at
// startup with a URL that resolves to `pdfjs-dist/build/pdf.worker.min.mjs`.
// In Next.js this is typically:
//
//   import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
//   setupPdfjsWorker(workerUrl);
//
// If the host doesn't set a worker, the kernel falls back to in-thread
// rendering (`disableWorker: true`) — slower but still correct.

import type {
  PDFDocumentProxy,
  PDFPageProxy,
  TextContent,
  TextItem,
} from 'pdfjs-dist/types/src/display/api.js';

/** Cached promise for the dynamically-imported pdfjs-dist module. */
let pdfjsModule: typeof import('pdfjs-dist') | null = null;
let pdfjsLoadingPromise: Promise<typeof import('pdfjs-dist')> | null = null;
let workerSrcConfigured = false;

/**
 * Set the worker URL. Must be called from the host app at startup, before
 * any PDF loading. Ignored if called more than once.
 */
export function setupPdfjsWorker(url: string): void {
  if (workerSrcConfigured) return;
  if (typeof window === 'undefined') return;
  // We assign as soon as pdfjs is loaded; if it isn't yet, this is captured
  // and applied on first load.
  workerUrl = url;
  workerSrcConfigured = true;
  if (pdfjsModule) {
    pdfjsModule.GlobalWorkerOptions.workerSrc = url;
  }
}

let workerUrl: string | null = null;

/**
 * Lazy-load pdfjs-dist. Returns null on the server. Caches the module
 * promise so concurrent callers share one import.
 */
export async function getPdfjs(): Promise<typeof import('pdfjs-dist') | null> {
  if (typeof window === 'undefined') return null;
  if (pdfjsModule) return pdfjsModule;
  if (pdfjsLoadingPromise) return pdfjsLoadingPromise;
  pdfjsLoadingPromise = import('pdfjs-dist').then((mod) => {
    if (workerUrl) mod.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfjsModule = mod;
    return mod;
  });
  return pdfjsLoadingPromise;
}

// ---------------------------------------------------------------------------
// Document / page helpers
// ---------------------------------------------------------------------------

export interface LoadDocumentOptions {
  /** PDF source — URL or ArrayBuffer/Uint8Array. */
  source: string | ArrayBuffer | Uint8Array;
  /** Optional bearer token to attach to the GET (Voyage's PDF fetcher). */
  authHeader?: string;
}

export async function loadDocument(opts: LoadDocumentOptions): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfjs();
  if (!pdfjs) throw new Error('pdfjs-dist is not available in this environment');

  const params: Parameters<typeof pdfjs.getDocument>[0] =
    typeof opts.source === 'string'
      ? { url: opts.source }
      : { data: opts.source };

  // Fall back to in-thread rendering if no worker URL was set up.
  if (!workerUrl) {
    (params as { disableWorker?: boolean }).disableWorker = true;
  }

  if (opts.authHeader) {
    (params as { httpHeaders?: Record<string, string> }).httpHeaders = {
      Authorization: opts.authHeader,
    };
  }

  const task = pdfjs.getDocument(params);
  return task.promise;
}

/** Width/height of a page at a given scale, plus the underlying viewport. */
export interface PageDimensions {
  width: number;
  height: number;
  scale: number;
}

export function getPageDimensions(page: PDFPageProxy, scale: number): PageDimensions {
  const viewport = page.getViewport({ scale });
  return { width: viewport.width, height: viewport.height, scale };
}

/**
 * Render a single page into the supplied canvas. Resolves once rendering is
 * complete. Caller is responsible for sizing the canvas; this function does
 * not modify width/height attributes (so the device-pixel-ratio dance stays
 * with the host component).
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context not available on canvas');
  const viewport = page.getViewport({ scale });
  const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
  await renderTask.promise;
}

// ---------------------------------------------------------------------------
// Text-layer extraction
// ---------------------------------------------------------------------------

/**
 * One contiguous run of text from the PDF text layer. Coordinates are in
 * scaled viewport pixels (top-left origin) so callers can position highlights
 * directly. Each run carries its character offset within the page-level
 * concatenated text so the excerpt locator can map matches back to a span.
 */
export interface TextRun {
  text: string;
  /** Character offset in the page's concatenated text where this run starts. */
  charStart: number;
  /** Character offset where this run ends (exclusive). */
  charEnd: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageTextLayer {
  /** All text runs concatenated in reading order, separated by spaces between
   *  runs from different items. This is what we search against. */
  pageText: string;
  runs: TextRun[];
}

/**
 * Extract the text layer for a page. Returns runs with positions in
 * `viewport` coordinate space (i.e., already multiplied by `scale`).
 *
 * pdfjs returns transforms in PDF coordinate space (y-up, origin bottom-
 * left). We convert to top-left CSS pixels via the viewport.transform.
 */
export async function getPageTextLayer(
  page: PDFPageProxy,
  scale: number,
): Promise<PageTextLayer> {
  const viewport = page.getViewport({ scale });
  const content: TextContent = await page.getTextContent();

  const runs: TextRun[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const item of content.items) {
    const ti = item as TextItem;
    const text = ti.str;

    // pdfjs gives transform = [scaleX, skewX, skewY, scaleY, x, y] in
    // PDF coords. Apply viewport transform to get CSS pixels.
    const tx = pdfjsTransform(viewport.transform, ti.transform);
    const x = tx[4];
    const y = tx[5];
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const fontWidth = Math.hypot(tx[0], tx[1]);
    // Width estimate: pdfjs gives ti.width in PDF coords; multiply by scale.
    const width = ti.width * scale;
    // Top-left y: the y returned is the baseline, so subtract fontHeight to
    // get the top of the glyph box.
    const top = y - fontHeight;

    if (text.length > 0) {
      runs.push({
        text,
        charStart: cursor,
        charEnd: cursor + text.length,
        x,
        y: top,
        width: width || fontWidth,
        height: fontHeight,
      });
      parts.push(text);
      cursor += text.length;
    }

    // hasEOL signals a soft line break in the text layer; insert a newline.
    if (ti.hasEOL) {
      parts.push('\n');
      cursor += 1;
    } else {
      // Insert a space between runs so adjacent words don't fuse together.
      parts.push(' ');
      cursor += 1;
    }
  }

  // Trim trailing separator we always append.
  let pageText = parts.join('');
  if (pageText.endsWith(' ') || pageText.endsWith('\n')) {
    pageText = pageText.slice(0, -1);
  }
  return { pageText, runs };
}

/** Multiply 2D affine transforms in pdfjs's [a,b,c,d,e,f] form. */
function pdfjsTransform(
  m1: ReadonlyArray<number>,
  m2: ReadonlyArray<number>,
): [number, number, number, number, number, number] {
  return [
    m1[0]! * m2[0]! + m1[2]! * m2[1]!,
    m1[1]! * m2[0]! + m1[3]! * m2[1]!,
    m1[0]! * m2[2]! + m1[2]! * m2[3]!,
    m1[1]! * m2[2]! + m1[3]! * m2[3]!,
    m1[0]! * m2[4]! + m1[2]! * m2[5]! + m1[4]!,
    m1[1]! * m2[4]! + m1[3]! * m2[5]! + m1[5]!,
  ];
}

// ---------------------------------------------------------------------------
// Range → character offset mapping (for editor selection capture)
// ---------------------------------------------------------------------------

/**
 * Given a DOM `Range` whose endpoints fall inside `<span>` elements rendered
 * for this page's text layer (each span carries `data-run-index`), compute
 * the character range within the page's concatenated text.
 *
 * Returns null if the selection is outside the text layer or empty.
 */
export function rangeToPageOffsets(
  range: Range,
  runs: ReadonlyArray<TextRun>,
): { charStart: number; charEnd: number } | null {
  const start = locateOffset(range.startContainer, range.startOffset, runs);
  const end = locateOffset(range.endContainer, range.endOffset, runs);
  if (start == null || end == null) return null;
  if (end <= start) return null;
  return { charStart: start, charEnd: end };
}

function locateOffset(
  container: Node,
  offsetInNode: number,
  runs: ReadonlyArray<TextRun>,
): number | null {
  // Walk up to the nearest element with data-run-index.
  let el: HTMLElement | null = null;
  let node: Node | null = container;
  while (node) {
    if (node.nodeType === 1) {
      const e = node as HTMLElement;
      if (e.dataset && e.dataset['runIndex'] != null) {
        el = e;
        break;
      }
    }
    node = node.parentNode;
  }
  if (!el) return null;
  const idx = Number(el.dataset['runIndex']);
  if (!Number.isFinite(idx) || idx < 0 || idx >= runs.length) return null;
  const run = runs[idx]!;
  // If `container` is the element itself (selection at element boundary),
  // offsetInNode is the index among child nodes — clamp to start/end of the
  // run.
  if (container === el) {
    return offsetInNode === 0 ? run.charStart : run.charEnd;
  }
  // Otherwise it's a text node inside; charStart + offsetInNode.
  return run.charStart + Math.min(offsetInNode, run.text.length);
}

// Re-export pdfjs types the host components need without forcing them to
// import from pdfjs-dist directly.
export type { PDFDocumentProxy, PDFPageProxy };
