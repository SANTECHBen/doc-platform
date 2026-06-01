// Figure-aware DOCX extraction, split into two phases so figure images are
// only decoded/extracted for the sections the admin actually selected:
//
//   1. extractDocxText  — markdown with [[FIGURE:fig-N]] tokens for every
//      embedded image, in document order, WITHOUT decoding any image bytes.
//      Cheap; runs at upload time to drive the section picker.
//   2. extractDocxFigureBytes(wantedIds) — re-walks the document and decodes
//      + normalizes ONLY the figures whose ids were requested (the ones whose
//      tokens fall inside the selected sections). Runs after section pick.
//
// Figure ids are positional (fig-1 = the first image in reading order, etc.),
// assigned to EVERY image in both passes, so the two passes agree on which id
// maps to which image regardless of whether a given image is decodable.

import { promises as fs } from 'node:fs';
import mammoth from 'mammoth';
import { htmlToMarkdown } from './docx.js';
import { ExtractionError } from './types.js';
import type { ExtractionResult } from './types.js';
import {
  attachCaptions,
  figureIdForIndex,
  normalizeFigureImage,
  type ExtractedFigure,
  type FigureAwareExtraction,
} from './figures.js';

const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Code'] => pre:fresh",
];

/**
 * Phase 1 — markdown + positional figure tokens, no image bytes decoded.
 */
export async function extractDocxText(
  filePath: string,
): Promise<{ markdown: string; meta: ExtractionResult['meta'] }> {
  const buffer = await readDocx(filePath);
  const notes: string[] = [];
  let imageCount = 0;

  try {
    const htmlResult = await mammoth.convertToHtml(
      { buffer },
      {
        // Emit a positional token for every image without reading its bytes —
        // the byte decode happens later, only for selected figures.
        convertImage: mammoth.images.imgElement(() => {
          const figureId = figureIdForIndex(imageCount);
          imageCount += 1;
          return Promise.resolve({ src: '', alt: `[[FIGURE:${figureId}]]` });
        }),
        styleMap: DOCX_STYLE_MAP,
      },
    );
    if (htmlResult.messages.length > 0) {
      notes.push(...htmlResult.messages.slice(0, 3).map((m) => m.message));
    }
    notes.push(`images detected: ${imageCount}`);
    const markdown = htmlToMarkdown(htmlResult.value);
    return { markdown, meta: { source: 'docx', quality: 0.95, notes } };
  } catch (err) {
    throw new ExtractionError('mammoth failed to parse DOCX (text phase)', err);
  }
}

/**
 * Phase 2 — decode + normalize bytes only for the requested figure ids.
 * Undecodable images (e.g. EMF/WMF vector) in the wanted set are skipped.
 */
export async function extractDocxFigureBytes(
  filePath: string,
  wantedIds: Set<string>,
): Promise<ExtractedFigure[]> {
  if (wantedIds.size === 0) return [];
  const buffer = await readDocx(filePath);
  const figures: ExtractedFigure[] = [];
  let imageCount = 0;

  try {
    await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const order = imageCount;
          const figureId = figureIdForIndex(order);
          imageCount += 1;
          if (!wantedIds.has(figureId)) return { src: '' };
          try {
            const raw = await image.read();
            const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            const normalized = await normalizeFigureImage(rawBuf);
            if (normalized) {
              figures.push({
                figureId,
                order,
                bytes: normalized.bytes,
                mime: normalized.mime,
                width: normalized.width,
                height: normalized.height,
              });
            }
          } catch {
            // undecodable — skip
          }
          return { src: '' };
        }),
        styleMap: DOCX_STYLE_MAP,
      },
    );
  } catch (err) {
    throw new ExtractionError('mammoth failed to parse DOCX (figure phase)', err);
  }
  figures.sort((a, b) => a.order - b.order);
  return figures;
}

/**
 * Full extraction (markdown + all figure bytes). Kept for tests and any
 * caller that wants the whole document at once; the section-scoped pipeline
 * uses the two phases above instead.
 */
export async function extractDocxWithFigures(
  filePath: string,
): Promise<FigureAwareExtraction> {
  const text = await extractDocxText(filePath);
  const ids = new Set(
    [...text.markdown.matchAll(/\[\[FIGURE:(fig-\d+)\]\]/g)].map((m) => m[1]!),
  );
  const figures = await extractDocxFigureBytes(filePath, ids);
  attachCaptions(text.markdown, figures);
  return { markdown: text.markdown, figures, pages: [], meta: text.meta };
}

async function readDocx(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    throw new ExtractionError(
      `Could not read DOCX file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
