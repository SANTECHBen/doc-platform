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

// Default worker URL — pinned to the version installed in this workspace.
// pdfjs-dist v5 always tries to load a worker module (even disableWorker
// mode dynamic-imports the fake worker), so we need a resolvable URL even
// when the host app's bundler doesn't bundle the worker as an asset.
//
// Resolution order:
//   1. Host app calls setupPdfjsWorker(url) — preferred; allows same-origin
//      hosting which removes the third-party CDN supply-chain dependency.
//   2. NEXT_PUBLIC_PDFJS_WORKER_URL env var (inlined into the client bundle).
//      Set this to a same-origin URL in production.
//   3. CDN fallback — pinned to a specific npm version so silent re-publish
//      doesn't change the bytes. CSP `script-src`/`worker-src` should
//      include this host explicitly.
const CDN_WORKER_URL =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.worker.min.mjs';

// WASM modules pdfjs v5 dynamic-imports for image decoders (JPEG 2000 / JPX
// via OpenJPEG, JBIG2, QCMS color profiles, QuickJS for AcroForms). Without a
// resolvable `wasmUrl`, pdfjs logs "OpenJPEG failed to initialize" and
// silently drops every JPX/JBIG2 image — scanned manuals turn into pages
// with text but empty image regions. The URL is a directory and MUST end
// with a trailing slash because pdfjs concatenates filenames directly.
const CDN_WASM_URL =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/wasm/';

function readEnvWorkerUrl(): string | null {
  // `process.env` is statically replaced by Next.js at build time, so this
  // only resolves the configured value — no runtime mutation possible.
  try {
    const url =
      typeof process !== 'undefined' &&
      process.env &&
      process.env.NEXT_PUBLIC_PDFJS_WORKER_URL;
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function readEnvWasmUrl(): string | null {
  try {
    const url =
      typeof process !== 'undefined' &&
      process.env &&
      process.env.NEXT_PUBLIC_PDFJS_WASM_URL;
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

const DEFAULT_WORKER_URL = readEnvWorkerUrl() ?? CDN_WORKER_URL;
const DEFAULT_WASM_URL = readEnvWasmUrl() ?? CDN_WASM_URL;

let workerUrl: string | null = DEFAULT_WORKER_URL;
let wasmUrl: string = DEFAULT_WASM_URL;
let wasmUrlConfigured = false;

/**
 * Override the worker URL. Optional — kernel uses a CDN default if you
 * don't call this. Ignored if called more than once.
 */
export function setupPdfjsWorker(url: string): void {
  if (workerSrcConfigured) return;
  if (typeof window === 'undefined') return;
  workerUrl = url;
  workerSrcConfigured = true;
  if (pdfjsModule) {
    pdfjsModule.GlobalWorkerOptions.workerSrc = url;
  }
}

/**
 * Override the WASM directory URL used for image-decoder modules
 * (OpenJPEG / JBIG2 / QCMS). Must end with a trailing slash. Optional —
 * defaults to the same CDN as the worker. Ignored after the first call.
 */
export function setupPdfjsWasm(url: string): void {
  if (wasmUrlConfigured) return;
  if (typeof window === 'undefined') return;
  wasmUrl = url.endsWith('/') ? url : `${url}/`;
  wasmUrlConfigured = true;
}

/**
 * Lazy-load pdfjs-dist. Returns null on the server. Caches the module
 * promise so concurrent callers share one import. Always sets a worker
 * URL (default CDN unless overridden via setupPdfjsWorker) because pdfjs
 * v5 dynamic-imports the worker even in disableWorker mode.
 */
export async function getPdfjs(): Promise<typeof import('pdfjs-dist') | null> {
  if (typeof window === 'undefined') return null;
  if (pdfjsModule) return pdfjsModule;
  if (pdfjsLoadingPromise) return pdfjsLoadingPromise;
  pdfjsLoadingPromise = import('pdfjs-dist').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = workerUrl ?? DEFAULT_WORKER_URL;
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

  if (opts.authHeader) {
    (params as { httpHeaders?: Record<string, string> }).httpHeaders = {
      Authorization: opts.authHeader,
    };
  }

  // wasmUrl points at the directory hosting pdfjs's image-decoder WASM
  // modules (OpenJPEG / JBIG2 / QCMS). Without it, JPX-compressed images
  // (common in scanned OEM manuals) fail to decode and render as blank
  // regions even though text on the same page renders fine. Typed via
  // cast because `wasmUrl` was added in pdfjs v5 and isn't reflected in
  // the package's public Parameters<> type yet.
  (params as { wasmUrl?: string }).wasmUrl = wasmUrl;

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
 *
 * Returns the underlying pdfjs RenderTask so callers can cancel an
 * in-flight render before starting a new one on the same canvas — pdfjs
 * throws "Cannot use the same canvas during multiple render operations"
 * if you don't, which is the common React failure mode when scale or
 * page-number changes while a previous render is still in flight.
 */
export interface CancellableRender {
  promise: Promise<void>;
  cancel(): void;
}

export function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
): CancellableRender {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context not available on canvas');
  const viewport = page.getViewport({ scale });
  const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
  return {
    promise: renderTask.promise.then(() => undefined),
    cancel: () => renderTask.cancel(),
  };
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

// ---------------------------------------------------------------------------
// Outline (TOC bookmarks)
// ---------------------------------------------------------------------------

/**
 * Flattened outline entry — a section/chapter from the PDF's built-in
 * outline tree (what a user sees in Acrobat/pdfjs's sidebar). `pageNumber`
 * is 1-indexed; `yFraction` is 0..1 from top of page (0 = top, 1 = bottom).
 */
export interface OutlineEntry {
  /** Display title of the entry — e.g. "4.11 Debris Detection Device Adjustment". */
  title: string;
  /** Depth in the outline tree (0 = top-level). */
  depth: number;
  /** 1-indexed page where this section starts. null if dest can't resolve. */
  pageNumber: number | null;
  /** 0..1 fractional Y on that page where this section starts. null if N/A. */
  yFraction: number | null;
}

/**
 * Load + flatten the PDF's outline (TOC bookmarks). Returns a depth-ordered
 * list of entries with resolved page/Y positions. Returns [] if the PDF
 * has no outline.
 */
export async function getOutlineEntries(
  pdf: PDFDocumentProxy,
): Promise<OutlineEntry[]> {
  const tree = await pdf.getOutline();
  if (!tree || tree.length === 0) return [];

  const out: OutlineEntry[] = [];
  // Walk depth-first, pushing one entry per node.
  async function walk(
    nodes: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>,
    depth: number,
  ): Promise<void> {
    if (!nodes) return;
    for (const node of nodes) {
      const resolved = await resolveDest(pdf, node.dest);
      out.push({
        title: node.title,
        depth,
        pageNumber: resolved?.pageNumber ?? null,
        yFraction: resolved?.yFraction ?? null,
      });
      if (node.items && node.items.length > 0) {
        await walk(node.items, depth + 1);
      }
    }
  }
  await walk(tree, 0);
  return out;
}

/**
 * Resolve a pdfjs outline destination (string ref or explicit array) to a
 * page number + fractional Y on the page. Returns null when the dest
 * doesn't carry enough info (no page, or unrecognized form).
 */
async function resolveDest(
  pdf: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<{ pageNumber: number; yFraction: number | null } | null> {
  if (!dest) return null;
  let arr: unknown[] | null = null;
  if (typeof dest === 'string') {
    const resolved = await pdf.getDestination(dest);
    if (!resolved) return null;
    arr = resolved as unknown[];
  } else if (Array.isArray(dest)) {
    arr = dest;
  }
  if (!arr || arr.length === 0) return null;

  // arr[0] is a pageRef; turn into a 1-indexed page number.
  let pageIndex: number;
  try {
    pageIndex = await pdf.getPageIndex(arr[0] as Parameters<typeof pdf.getPageIndex>[0]);
  } catch {
    return null;
  }
  const pageNumber = pageIndex + 1;

  // arr[1] is the destination "type". Common cases:
  //   ['XYZ', x, y, zoom] — pdfjs y is in PDF coords (bottom-up), so to
  //     get top-down fraction we need the page height.
  //   ['Fit'] — fits whole page; no Y. Treat as start of page.
  //   ['FitH', y] — y is in PDF coords (bottom-up).
  //   Others — fall through to start of page.
  const type = (arr[1] as { name?: string } | undefined)?.name;
  let pdfY: number | null = null;
  if (type === 'XYZ' && typeof arr[3] === 'number') pdfY = arr[3];
  else if (type === 'FitH' && typeof arr[2] === 'number') pdfY = arr[2];
  else if (type === 'FitV' || type === 'Fit') pdfY = null;

  if (pdfY == null) return { pageNumber, yFraction: 0 };

  // Convert PDF coords (origin bottom-left, y up) to top-down fraction.
  let pageHeight: number;
  try {
    const page = await pdf.getPage(pageNumber);
    const v = page.getViewport({ scale: 1 });
    pageHeight = v.height;
  } catch {
    return { pageNumber, yFraction: 0 };
  }
  const yFraction = Math.max(0, Math.min(1, (pageHeight - pdfY) / pageHeight));
  return { pageNumber, yFraction };
}

// Re-export pdfjs types the host components need without forcing them to
// import from pdfjs-dist directly.
export type { PDFDocumentProxy, PDFPageProxy };
