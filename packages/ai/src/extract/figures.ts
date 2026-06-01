// Figure extraction shared types + helpers.
//
// The RAG extractors (extract/index.ts) deliberately DROP images — retrieval
// reads text, not pixels. The procedure importer needs the opposite: it must
// pull each embedded figure out as real bytes, keep its reading-order
// position in the markdown (so the LLM can match "see Figure 3" to the right
// image), and hand the bytes to the API layer to upload to object storage.
//
// Flow:
//   docx/pdf-figures.ts  ->  ExtractedFigure[] (bytes in memory)
//   doc-draft-pipeline   ->  upload each, produce DraftFigure[] (storage keys)
//   doc-executor         ->  wire DraftFigure into step media[] + photo_inline

import sharp from 'sharp';
import type { ExtractedPage, ExtractionResult } from './types.js';

/** One figure pulled from a document, bytes still in memory (pre-upload). */
export interface ExtractedFigure {
  /** Stable id the LLM matches against, e.g. "fig-3". Assigned in document
   *  reading order. Embedded as a `[[FIGURE:fig-3]]` token in the markdown. */
  figureId: string;
  /** 0-based position in reading order. */
  order: number;
  /** Normalized image bytes (JPEG or PNG — see normalizeFigureImage). */
  bytes: Buffer;
  /** image/jpeg | image/png. */
  mime: string;
  width: number | null;
  height: number | null;
  /** Caption text captured adjacent to the figure, if any. */
  caption?: string;
}

/** Figure-aware extraction output. Mirrors ExtractionResult but adds figures
 *  and carries `[[FIGURE:id]]` tokens inline in the markdown. */
export interface FigureAwareExtraction {
  markdown: string;
  figures: ExtractedFigure[];
  pages: ExtractedPage[];
  meta: ExtractionResult['meta'];
}

// Longest edge we keep. Procedure figures render at a few hundred px in the
// runner; 2000px is plenty and caps a stray full-res photo from bloating
// storage and the reviewer payload.
const MAX_EDGE_PX = 2000;

/** Build the inline token that marks where a figure sat in the document. */
export function figureToken(figureId: string): string {
  return `[[FIGURE:${figureId}]]`;
}

/** Assign the Nth figure id (0-based) → "fig-1", "fig-2", … (1-based label). */
export function figureIdForIndex(index: number): string {
  return `fig-${index + 1}`;
}

/** Matches a figure token in markdown, capturing the id. Global + multiline. */
export const FIGURE_TOKEN_RE = /\[\[FIGURE:(fig-\d+)\]\]/g;

export interface NormalizedImage {
  bytes: Buffer;
  mime: 'image/jpeg' | 'image/png';
  width: number | null;
  height: number | null;
}

/**
 * Re-encode a raw embedded image to a bounded, web-friendly form:
 *   - cap the longest edge to MAX_EDGE_PX (never upscale)
 *   - keep transparency as PNG, otherwise flatten to JPEG q82
 * Returns null when sharp can't decode the bytes (e.g. EMF/WMF vector art
 * that Word sometimes embeds) — the caller skips that figure rather than
 * emitting a broken token.
 */
export async function normalizeFigureImage(
  raw: Buffer,
): Promise<NormalizedImage | null> {
  try {
    // failOn:'none' keeps sharp from rejecting mildly-malformed but
    // decodable images (common in OEM-authored Word docs).
    const img = sharp(raw, { failOn: 'none' });
    const meta = await img.metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    let pipeline = img;
    if (longest > MAX_EDGE_PX) {
      pipeline = pipeline.resize(MAX_EDGE_PX, MAX_EDGE_PX, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    if (meta.hasAlpha) {
      const out = await pipeline.png().toBuffer({ resolveWithObject: true });
      return {
        bytes: out.data,
        mime: 'image/png',
        width: out.info.width,
        height: out.info.height,
      };
    }
    const out = await pipeline
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: out.data,
      mime: 'image/jpeg',
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort caption capture. For each figure token, look at the next
 * non-empty markdown line; if it opens with "Figure"/"Fig" (a caption
 * convention nearly universal in OEM manuals), attach it. Mutates the
 * figures array in place and returns it for chaining.
 */
export function attachCaptions(
  markdown: string,
  figures: ExtractedFigure[],
): ExtractedFigure[] {
  if (figures.length === 0) return figures;
  const byId = new Map(figures.map((f) => [f.figureId, f]));
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const tokenMatch = lines[i]!.match(/\[\[FIGURE:(fig-\d+)\]\]/);
    if (!tokenMatch) continue;
    const fig = byId.get(tokenMatch[1]!);
    if (!fig || fig.caption) continue;
    // Scan forward for the first non-empty line that isn't itself a token.
    for (let j = i; j < Math.min(i + 4, lines.length); j += 1) {
      const text = lines[j]!.replace(/\[\[FIGURE:fig-\d+\]\]/g, '').trim();
      if (!text) continue;
      if (/^(figure|fig\.?)\s*\d+/i.test(text)) {
        fig.caption = text.slice(0, 300);
      }
      break;
    }
  }
  return figures;
}
