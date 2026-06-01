// Figure-aware DOCX extraction.
//
// extractDocx() (docx.ts) drops images because RAG can't read pixels. The
// procedure importer needs them: each embedded figure becomes an
// ExtractedFigure with real bytes, and a `[[FIGURE:fig-N]]` token is left
// exactly where the image sat so the LLM can place it on the right step.
//
// How position is preserved: mammoth converts the document to HTML in reading
// order. We hand it a `convertImage` callback that (a) reads the image bytes,
// (b) normalizes them via sharp, (c) assigns the next sequential figure id,
// and (d) returns an <img alt="[[FIGURE:fig-N]]"> marker. htmlToMarkdown then
// turns that marker into the inline literal token. Because the callback fires
// as mammoth walks the document, ids land in reading order.

import { promises as fs } from 'node:fs';
import mammoth from 'mammoth';
import { htmlToMarkdown } from './docx.js';
import { ExtractionError } from './types.js';
import {
  attachCaptions,
  figureIdForIndex,
  normalizeFigureImage,
  type ExtractedFigure,
  type FigureAwareExtraction,
} from './figures.js';

export async function extractDocxWithFigures(
  filePath: string,
): Promise<FigureAwareExtraction> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (err) {
    throw new ExtractionError(
      `Could not read DOCX file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const notes: string[] = [];
  const figures: ExtractedFigure[] = [];
  let skipped = 0;
  // mammoth invokes convertImage in document order; this counter assigns
  // ids in that same order. Incremented only for figures we actually keep
  // so the ids stay dense (fig-1, fig-2, …).
  let nextIndex = 0;

  try {
    const htmlResult = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          try {
            const raw = await image.read();
            const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            const normalized = await normalizeFigureImage(rawBuf);
            if (!normalized) {
              // Undecodable (e.g. EMF/WMF vector). Drop it silently from the
              // figure pool and emit no token, leaving an empty src so the
              // tag is harmless.
              skipped += 1;
              return { src: '' };
            }
            const figureId = figureIdForIndex(nextIndex);
            figures.push({
              figureId,
              order: nextIndex,
              bytes: normalized.bytes,
              mime: normalized.mime,
              width: normalized.width,
              height: normalized.height,
            });
            nextIndex += 1;
            // src stays empty (we don't inline base64); the alt marker is what
            // htmlToMarkdown converts into the positional token.
            return { src: '', alt: `[[FIGURE:${figureId}]]` };
          } catch {
            skipped += 1;
            return { src: '' };
          }
        }),
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Code'] => pre:fresh",
        ],
      },
    );

    if (htmlResult.messages.length > 0) {
      notes.push(...htmlResult.messages.slice(0, 3).map((m) => m.message));
      if (htmlResult.messages.length > 3) {
        notes.push(`… and ${htmlResult.messages.length - 3} more warnings`);
      }
    }
    if (skipped > 0) {
      notes.push(`${skipped} image(s) could not be decoded and were skipped`);
    }
    notes.push(`figures extracted: ${figures.length}`);

    const markdown = htmlToMarkdown(htmlResult.value);
    attachCaptions(markdown, figures);

    return {
      markdown,
      figures,
      pages: [],
      meta: { source: 'docx', quality: 0.95, notes },
    };
  } catch (err) {
    throw new ExtractionError('mammoth failed to parse DOCX (figure-aware)', err);
  }
}
