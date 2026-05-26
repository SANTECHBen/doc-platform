// PPTX → per-slide PNG renderer.
//
// Sits next to the existing text-extractor (pptx.ts) — that pulls strings
// out of the OOXML; this rasterizes each slide to an image so the PWA
// player has something visual to show. They run sequentially in the
// pipeline: text first (cheap, always tried), images second (expensive,
// best-effort).
//
// Why two external binaries and not one library?
//   • A pure-Node PPTX renderer doesn't exist with acceptable fidelity.
//     Anything that opens the OOXML and re-paints in SVG/Canvas misses
//     fonts, animations, embedded media, shape effects.
//   • LibreOffice headless renders the PPTX through Impress's own
//     layout engine to PDF — same code path Microsoft Office users would
//     follow when "Save as PDF". This is the highest fidelity option
//     short of running PowerPoint in a VM.
//   • PDF → PNG via Poppler's `pdftoppm` is then a 50-line job. We
//     already render PDFs page-by-page in the admin via pdf.js for Doc
//     Sections, so picking pdftoppm here keeps the system simple.
//
// Costs:
//   • Image size: libreoffice-impress + poppler-utils adds ~280 MB to
//     the Fly image (see packages/api/Dockerfile).
//   • Latency: ~20 s for a 20-slide deck on a 1-CPU worker box; PDFs
//     can take longer for image-heavy decks. Run async so the admin
//     API never blocks.
//
// Idempotency:
//   • Re-running on the same PPTX clears stale PNGs from storage by
//     overwriting under the same key (storage adapter dedups). Existing
//     slideDeckSlides rows are upserted by (slideDeckId, slideIndex) so
//     interactions/voiceover stay attached to "slide 3" across re-renders.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { and, eq, gte, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema, type Database } from '@platform/db';

export interface SlideRenderInput {
  db: Database;
  /** Already-downloaded PPTX on local disk. The pipeline owns the file
   *  lifecycle; we only read it. */
  pptxPath: string;
  /** Document ID this PPTX came from. We upsert the slideDecks row for
   *  this document. */
  documentId: string;
  /** Owner-org for storage tenant prefixing. Pulled from the document's
   *  contentPackVersion → pack chain. */
  ownerOrganizationId: string;
  /** Optional speaker-notes per slide (1-based slide index). Seeds each
   *  slide's scriptMarkdown when the row is first created. Falls back to
   *  empty when missing. The text-extractor (pptx.ts) is the source of
   *  truth — we just borrow what it already parsed. */
  speakerNotesBySlide?: Map<number, string>;
  /** Storage adapter — used to upload each rendered PNG. We accept it
   *  as a callback rather than importing @platform/api's storage type so
   *  the ai package stays free of HTTP-stack coupling. */
  putPng: (input: {
    buffer: Buffer;
    filename: string;
    ownerOrganizationId: string;
  }) => Promise<{ storageKey: string }>;
  log?: {
    info: (data: unknown, msg?: string) => void;
    warn: (data: unknown, msg?: string) => void;
    error: (data: unknown, msg?: string) => void;
  };
}

export interface SlideRenderResult {
  slideDeckId: string;
  slideCount: number;
}

// Cap each external command. LibreOffice has been observed to hang on
// rare corrupt decks; pdftoppm is fast per page but a 100+ slide deck on
// a shared-CPU worker can still take 5+ minutes. Generous ceilings here
// to avoid timing out real work; truly stuck binaries still get killed.
const SOFFICE_TIMEOUT_MS = 15 * 60_000;
const PDFTOPPM_TIMEOUT_MS = 20 * 60_000;
// 150 DPI gives ~2000px wide PNGs from a standard 16:9 deck — sharp
// enough for retina screens, small enough that 100-slide decks stay
// well under 100 MB total.
const RENDER_DPI = 150;

export async function convertPptxToSlideImages(
  input: SlideRenderInput,
): Promise<SlideRenderResult> {
  const { db, pptxPath, documentId, ownerOrganizationId } = input;
  const log = input.log ?? consoleLogShim();

  // 1. Upsert the slideDecks row → 'processing'. Done up-front so a UI
  // poll mid-conversion sees the right state. ON CONFLICT keeps any
  // author-configured passThreshold on a re-conversion.
  const deck = await db
    .insert(schema.slideDecks)
    .values({
      documentId,
      conversionStatus: 'processing',
      conversionError: null,
      conversionStartedAt: new Date(),
      slideCount: 0,
    })
    .onConflictDoUpdate({
      target: schema.slideDecks.documentId,
      set: {
        conversionStatus: 'processing',
        conversionError: null,
        conversionStartedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.slideDecks.id });
  const slideDeckId = deck[0]!.id;
  log.info({ documentId, slideDeckId }, 'slide-render: upserted deck row');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slide-render-'));
  try {
    // 2. PPTX → PDF via LibreOffice. --headless prevents GUI init; we still
    // pass --norestore --nologo --nofirststartwizard because some distros
    // ignore --headless on a cold profile and pop a dialog.
    const pdfOutDir = path.join(tempDir, 'pdf');
    await fs.mkdir(pdfOutDir, { recursive: true });
    await runWithTimeout(
      'soffice',
      [
        '--headless',
        '--norestore',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        pdfOutDir,
        pptxPath,
      ],
      SOFFICE_TIMEOUT_MS,
      log,
    );

    // LibreOffice names the PDF after the input file (sans extension).
    const pdfEntries = await fs.readdir(pdfOutDir);
    const pdfName = pdfEntries.find((n) => n.toLowerCase().endsWith('.pdf'));
    if (!pdfName) {
      throw new Error(
        `LibreOffice produced no PDF (output dir empty: ${pdfEntries.join(', ') || '<none>'})`,
      );
    }
    const pdfPath = path.join(pdfOutDir, pdfName);

    // 3. PDF → PNG per page via Poppler's pdftoppm. -r sets DPI; the
    // command writes files named `<prefix>-N.png` with N = page number
    // (1-based, padded as needed). We pass `-png` to skip PPM/JPEG.
    const pngOutDir = path.join(tempDir, 'png');
    await fs.mkdir(pngOutDir, { recursive: true });
    const pngPrefix = path.join(pngOutDir, 'slide');
    await runWithTimeout(
      'pdftoppm',
      ['-r', String(RENDER_DPI), '-png', pdfPath, pngPrefix],
      PDFTOPPM_TIMEOUT_MS,
      log,
    );

    const pngFiles = (await fs.readdir(pngOutDir))
      .filter((n) => /^slide-\d+\.png$/i.test(n))
      .sort(bySlideNumber);
    if (pngFiles.length === 0) {
      throw new Error('pdftoppm produced no PNGs');
    }
    log.info({ slideDeckId, slideCount: pngFiles.length }, 'slide-render: PNGs ready');

    // 4. Upload each PNG + read its dimensions. We do this sequentially
    // to keep peak memory low (sharp + upload can be ~30 MB per slide).
    const newSlides: Array<{
      slideIndex: number;
      imageStorageKey: string;
      imageWidth: number;
      imageHeight: number;
      speakerNotesMarkdown: string | null;
    }> = [];
    for (let i = 0; i < pngFiles.length; i += 1) {
      const filename = pngFiles[i]!;
      const fullPath = path.join(pngOutDir, filename);
      const buffer = await fs.readFile(fullPath);
      const meta = await sharp(buffer).metadata();
      const { storageKey } = await input.putPng({
        buffer,
        filename: `slide-${i + 1}.png`,
        ownerOrganizationId,
      });
      newSlides.push({
        slideIndex: i,
        imageStorageKey: storageKey,
        imageWidth: meta.width ?? 0,
        imageHeight: meta.height ?? 0,
        speakerNotesMarkdown: input.speakerNotesBySlide?.get(i + 1) ?? null,
      });
    }

    // 5. Upsert slideDeckSlides keyed by (slideDeckId, slideIndex). This
    // preserves IDs (and thereby slideInteractions FKs) when the same
    // PPTX is re-rendered after edits in PowerPoint. Slides past the new
    // count are dropped — interactions on those will cascade-delete.
    await db.transaction(async (tx) => {
      for (const s of newSlides) {
        await tx
          .insert(schema.slideDeckSlides)
          .values({
            slideDeckId,
            slideIndex: s.slideIndex,
            orderingHint: s.slideIndex,
            imageStorageKey: s.imageStorageKey,
            imageWidth: s.imageWidth,
            imageHeight: s.imageHeight,
            speakerNotesMarkdown: s.speakerNotesMarkdown,
            // Seed the editable script with the speaker notes so authors
            // have a starting point. They can edit freely afterwards.
            scriptMarkdown: s.speakerNotesMarkdown,
          })
          .onConflictDoUpdate({
            target: [
              schema.slideDeckSlides.slideDeckId,
              schema.slideDeckSlides.slideIndex,
            ],
            set: {
              imageStorageKey: s.imageStorageKey,
              imageWidth: s.imageWidth,
              imageHeight: s.imageHeight,
              // Only overwrite speaker notes — leave script/voiceover/
              // interactions/title/gate alone so author edits survive
              // a re-render.
              speakerNotesMarkdown: s.speakerNotesMarkdown,
              updatedAt: new Date(),
            },
          });
      }
      // Drop slides past the new count.
      await tx
        .delete(schema.slideDeckSlides)
        .where(
          and(
            eq(schema.slideDeckSlides.slideDeckId, slideDeckId),
            gte(schema.slideDeckSlides.slideIndex, newSlides.length),
          ),
        );
      await tx
        .update(schema.slideDecks)
        .set({
          conversionStatus: 'ready',
          conversionError: null,
          conversionCompletedAt: new Date(),
          slideCount: newSlides.length,
          updatedAt: new Date(),
        })
        .where(eq(schema.slideDecks.id, slideDeckId));
    });

    log.info(
      { slideDeckId, slideCount: newSlides.length },
      'slide-render: completed',
    );
    return { slideDeckId, slideCount: newSlides.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.slideDecks)
      .set({
        conversionStatus: 'failed',
        conversionError: msg.slice(0, 4000),
        updatedAt: new Date(),
      })
      .where(eq(schema.slideDecks.id, slideDeckId));
    log.error({ documentId, slideDeckId, error: msg }, 'slide-render: failed');
    throw err;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// -----------------------------------------------------------------------------

async function runWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  log: NonNullable<SlideRenderInput['log']>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn ${command}: ${err.message}. Is the binary installed in the container?`,
        ),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const tail = (stderr || stdout).split('\n').slice(-6).join(' | ').trim();
        reject(new Error(`${command} exited ${code}: ${tail || '<no output>'}`));
        return;
      }
      log.info({ command, args }, 'slide-render: command ok');
      resolve();
    });
  });
}

function bySlideNumber(a: string, b: string): number {
  const na = Number(a.match(/slide-(\d+)\.png$/i)?.[1] ?? 0);
  const nb = Number(b.match(/slide-(\d+)\.png$/i)?.[1] ?? 0);
  return na - nb;
}

function consoleLogShim(): NonNullable<SlideRenderInput['log']> {
  // eslint-disable-next-line no-console
  return {
    info: (d, m) => console.log(JSON.stringify({ level: 'info', msg: m, ...(typeof d === 'object' && d ? (d as object) : { d }) })),
    // eslint-disable-next-line no-console
    warn: (d, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...(typeof d === 'object' && d ? (d as object) : { d }) })),
    // eslint-disable-next-line no-console
    error: (d, m) => console.error(JSON.stringify({ level: 'error', msg: m, ...(typeof d === 'object' && d ? (d as object) : { d }) })),
  };
}

// -----------------------------------------------------------------------------

/**
 * Extract speaker-notes per slide from a PPTX, returning a Map keyed by
 * 1-based slide number. Re-uses the existing JSZip + fast-xml-parser
 * machinery from extractPptx but exposes only the per-slide notes — used
 * by the renderer to seed slideDeckSlides.scriptMarkdown without
 * re-implementing OOXML parsing.
 *
 * Defensive: never throws — returns an empty map on failure. The render
 * still proceeds; notes are nice-to-have, not load-bearing.
 */
export async function readSpeakerNotesFromPptx(
  pptxPath: string,
): Promise<Map<number, string>> {
  try {
    const { promises: fsPromises } = await import('node:fs');
    const JSZip = (await import('jszip')).default;
    const { XMLParser } = await import('fast-xml-parser');
    const buffer = await fsPromises.readFile(pptxPath);
    const zip = await JSZip.loadAsync(buffer);
    const parser = new XMLParser({
      ignoreAttributes: false,
      preserveOrder: false,
      trimValues: true,
      parseTagValue: false,
    });

    const out = new Map<number, string>();
    const noteFiles = Object.keys(zip.files).filter((n) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n),
    );
    for (const file of noteFiles) {
      const m = file.match(/notesSlide(\d+)\.xml/i);
      if (!m) continue;
      const idx = Number(m[1]);
      const xml = await zip.file(file)!.async('string');
      const text = extractAllText(parser.parse(xml))
        .replace(/Click to add notes/gi, '')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (text) out.set(idx, text);
    }
    return out;
  } catch {
    return new Map();
  }
}

function extractAllText(node: unknown, acc: string[] = []): string {
  if (node === null || node === undefined) return acc.join('\n');
  if (typeof node === 'string') {
    if (node.trim()) acc.push(node);
    return acc.join('\n');
  }
  if (typeof node !== 'object') return acc.join('\n');
  if (Array.isArray(node)) {
    for (const v of node) extractAllText(v, acc);
    return acc.join('\n');
  }
  const obj = node as Record<string, unknown>;
  if ('a:t' in obj) {
    const t = obj['a:t'];
    if (typeof t === 'string' && t.trim()) acc.push(t);
    else if (t && typeof t === 'object' && '#text' in (t as Record<string, unknown>)) {
      const v = (t as Record<string, unknown>)['#text'];
      if (typeof v === 'string' && v.trim()) acc.push(v);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'a:t') continue;
    extractAllText(v, acc);
  }
  return acc.join('\n');
}
