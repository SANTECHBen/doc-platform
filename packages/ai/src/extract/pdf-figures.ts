// Figure-aware PDF extraction.
//
// Text + structure come from LlamaParse (extractPdf) exactly as the RAG path
// uses it — its markdown already carries page markers and "Figure N" text
// references. Figure *images* are pulled separately, best-effort, by walking
// each page's operator list with pdfjs and decoding the embedded image
// XObjects.
//
// PDF figure extraction is inherently lower-fidelity than DOCX (vector-only
// "figures" have no raster, CMYK/indexed color, inline images) — see the plan
// risk note. Everything here is defensive: any failure yields zero figures
// plus a note, and the importer still produces sections/steps/voiceover. The
// admin can attach figures to PDF-sourced steps in the reviewer.
//
// Positioning: extracted figures are tagged with their source page, and we
// inject `[[FIGURE:fig-N]]` tokens right after that page's `<!-- page:N -->`
// marker so the LLM sees each figure in roughly the right place.

import { promises as fs } from 'node:fs';
import { extractPdf } from './pdf.js';
import {
  figureIdForIndex,
  normalizeFigureImage,
  type ExtractedFigure,
  type FigureAwareExtraction,
} from './figures.js';

export interface PdfFigureExtractInput {
  filePath: string;
  sourceUrl?: string | null;
}

export async function extractPdfWithFigures(
  input: PdfFigureExtractInput,
): Promise<FigureAwareExtraction> {
  const base = await extractPdf({
    filePath: input.filePath,
    sourceUrl: input.sourceUrl,
  });

  let figures: ExtractedFigure[] = [];
  const notes = [...base.meta.notes];
  let pageOf = new Map<string, number>();
  try {
    const result = await extractPdfImages(input.filePath);
    figures = result.figures;
    pageOf = result.pageOf;
    notes.push(`figures extracted: ${figures.length}`);
  } catch (err) {
    notes.push(
      `PDF figure extraction unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        'attach figures manually in review',
    );
  }

  const markdown =
    figures.length > 0
      ? injectFigureTokens(base.markdown, figures, pageOf)
      : base.markdown;

  return {
    markdown,
    figures,
    pages: base.pages,
    meta: { source: 'pdf', quality: base.meta.quality, notes },
  };
}

/** Insert each figure's token after the `<!-- page:N -->` marker for its
 *  source page. Figures whose page we couldn't determine are appended at the
 *  end so they're still offered to the LLM. */
function injectFigureTokens(
  markdown: string,
  figures: ExtractedFigure[],
  pageOf: Map<string, number>,
): string {
  const byPage = new Map<number, string[]>();
  const orphans: string[] = [];
  for (const f of figures) {
    const page = pageOf.get(f.figureId);
    const token = `\n\n[[FIGURE:${f.figureId}]]\n\n`;
    if (page == null) {
      orphans.push(token);
      continue;
    }
    const arr = byPage.get(page) ?? [];
    arr.push(token);
    byPage.set(page, arr);
  }
  let out = markdown.replace(/<!--\s*page:(\d+)\s*-->/g, (whole, n) => {
    const tokens = byPage.get(Number(n));
    return tokens && tokens.length > 0 ? `${whole}${tokens.join('')}` : whole;
  });
  if (orphans.length > 0) out += orphans.join('');
  return out;
}

/**
 * Walk a PDF with pdfjs and decode embedded image XObjects. Dynamic-imported
 * legacy build (no DOM needed for operator lists). Defensive throughout: a
 * page that throws is skipped, not fatal.
 */
async function extractPdfImages(filePath: string): Promise<{
  figures: ExtractedFigure[];
  pageOf: Map<string, number>;
}> {
  // Legacy build runs under Node without a DOM. Dynamic import so a missing /
  // incompatible pdfjs never breaks module load for the (fully working) text
  // path.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjs.getDocument({
    data,
    // No worker in Node; run on the main thread.
    disableWorker: true,
    isEvalSupported: false,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;

  const figures: ExtractedFigure[] = [];
  const pageOf = new Map<string, number>();
  let index = 0;

  const numPages = doc.numPages;
  for (let pageNum = 1; pageNum <= numPages; pageNum += 1) {
    let page: Awaited<ReturnType<typeof doc.getPage>>;
    try {
      page = await doc.getPage(pageNum);
    } catch {
      continue;
    }
    try {
      const ops = await page.getOperatorList();
      const { OPS } = pdfjs;
      const imageNames: string[] = [];
      for (let i = 0; i < ops.fnArray.length; i += 1) {
        const fn = ops.fnArray[i];
        if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
          const arg = ops.argsArray[i]?.[0];
          if (typeof arg === 'string') imageNames.push(arg);
        }
      }
      for (const name of imageNames) {
        const img = await resolveImage(page, name);
        if (!img) continue;
        const png = await rgbaToPngBuffer(img);
        if (!png) continue;
        const normalized = await normalizeFigureImage(png);
        if (!normalized) continue;
        const figureId = figureIdForIndex(index);
        figures.push({
          figureId,
          order: index,
          bytes: normalized.bytes,
          mime: normalized.mime,
          width: normalized.width,
          height: normalized.height,
          caption: `Figure on page ${pageNum}`,
        });
        pageOf.set(figureId, pageNum);
        index += 1;
      }
    } catch {
      // skip the page
    } finally {
      page.cleanup();
    }
  }
  await doc.cleanup();
  return { figures, pageOf };
}

interface RawImage {
  width: number;
  height: number;
  kind?: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Resolve an image object from a page's object store. After
 *  getOperatorList(), image XObjects are queued in page.objs; get() with a
 *  callback resolves once decoded. */
function resolveImage(
  page: { objs: { get(name: string, cb: (data: unknown) => void): void } },
  name: string,
): Promise<RawImage | null> {
  return new Promise((resolve) => {
    try {
      page.objs.get(name, (data: unknown) => {
        const img = data as RawImage | null;
        if (img && img.width && img.height && img.data) resolve(img);
        else resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Convert a pdfjs raw image (RGBA or RGB, possibly 3-channel) into PNG bytes
 *  via sharp. pdfjs `kind`: 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP. */
async function rgbaToPngBuffer(img: RawImage): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    const bytes = Buffer.from(
      img.data.buffer,
      img.data.byteOffset,
      img.data.byteLength,
    );
    const total = img.width * img.height;
    let channels: 1 | 3 | 4;
    if (img.data.byteLength >= total * 4) channels = 4;
    else if (img.data.byteLength >= total * 3) channels = 3;
    else channels = 1;
    return await sharp(bytes, {
      raw: { width: img.width, height: img.height, channels },
    })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
