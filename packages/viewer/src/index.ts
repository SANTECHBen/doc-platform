// Public surface of @platform/viewer.

export {
  setupPdfjsWorker,
  getPdfjs,
  loadDocument,
  getPageDimensions,
  renderPageToCanvas,
  getPageTextLayer,
  rangeToPageOffsets,
  type LoadDocumentOptions,
  type PageDimensions,
  type PageTextLayer,
  type TextRun,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from './pdf-kernel.js';

export {
  locateExcerptInPage,
  rectsForSpan,
  type LocateOptions,
  type LocateResult,
  type RunPosition,
  type HighlightRect,
} from './utils/excerpt-locator.js';

export { PdfPage, type PdfPageProps } from './components/pdf-page.js';
export {
  SectionHighlight,
  type SectionHighlightProps,
  type HighlightRectInput,
} from './components/section-highlight.js';
