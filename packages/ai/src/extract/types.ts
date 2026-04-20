// Shared shapes for the extraction layer. Each extractor produces the same
// normalized output — markdown text plus optional page boundaries — so the
// chunker upstream doesn't need to branch on the source format.

export interface ExtractedPage {
  /** 1-indexed page number as it appears in the source document. */
  pageNumber: number;
  /** Character offset into the full `markdown` string where this page starts. */
  charStart: number;
  /** Character offset (exclusive) where this page ends. */
  charEnd: number;
}

export interface ExtractionResult {
  /**
   * Normalized markdown representation of the document. Headings become `#`/`##`,
   * lists become `-` / `1.`, tables become GFM tables, etc. Downstream chunking
   * is structure-aware and uses these markers.
   */
  markdown: string;
  /**
   * Per-page character ranges when the source has a page model (PDF / PPTX).
   * Used for citations ("… page 4") without re-parsing the source. Empty for
   * formats without a page concept (DOCX).
   */
  pages: ExtractedPage[];
  /**
   * Informational fields the extractor learned along the way. Never used for
   * retrieval; surfaced in logs / admin UI.
   */
  meta: {
    source: 'pdf' | 'docx' | 'pptx';
    /** Heuristic 0–1 score for extraction quality. Low = consider reprocessing. */
    quality: number;
    /** Extractor notes ("used Claude PDF fallback", "2 slides had no text"). */
    notes: string[];
  };
}

export class ExtractionError extends Error {
  public readonly extractionCause?: unknown;
  constructor(message: string, extractionCause?: unknown) {
    super(message);
    this.name = 'ExtractionError';
    this.extractionCause = extractionCause;
  }
}
