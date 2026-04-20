// PPTX extraction. A .pptx file is a ZIP archive of OOXML documents:
//   - ppt/slides/slide1.xml, slide2.xml, ...      (slide content)
//   - ppt/notesSlides/notesSlide1.xml, ...        (speaker notes)
//   - ppt/presentation.xml                        (ordering / slide IDs)
//
// We pull text from every <a:t> element in each slide, add speaker notes
// (which frequently contain the real operator knowledge — the slide shows
// a diagram while the notes explain what to do), and keep each slide as its
// own logical page so citations can say "slide 4".

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { ExtractionResult, ExtractedPage } from './types.js';
import { ExtractionError } from './types.js';

export async function extractPptx(buffer: Buffer): Promise<ExtractionResult> {
  const notes: string[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ExtractionError('Failed to open PPTX (invalid ZIP)', err);
  }

  // Collect slide files in numeric order so "slide 4" in the UI matches the
  // deck's slide 4. ZIP filenames are strings, so "slide10.xml" would sort
  // before "slide2.xml" lexicographically — sort numerically.
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort(bySlideNumber);

  if (slideFiles.length === 0) {
    throw new ExtractionError('PPTX contains no slides');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: false,
    trimValues: true,
    parseTagValue: false,
  });

  const pages: ExtractedPage[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let emptySlides = 0;

  for (let i = 0; i < slideFiles.length; i += 1) {
    const slideXml = await zip.file(slideFiles[i]!)!.async('string');
    const slideText = extractTextRuns(slideXml, parser);
    const notesText = await loadNotesForSlide(zip, i + 1, parser);

    const slideNumber = i + 1;
    const titleGuess = slideText.split('\n')[0]?.trim() ?? `Slide ${slideNumber}`;
    const slideHeading = `## Slide ${slideNumber}: ${titleGuess || `Slide ${slideNumber}`}`;
    const slideBody = slideText.replace(/^.*\n?/, '').trim(); // drop first line (used as title)

    const sections: string[] = [slideHeading];
    if (slideBody) sections.push(slideBody);
    if (notesText) sections.push(`*Speaker notes:* ${notesText}`);

    const block = sections.join('\n\n');
    const hasContent = slideBody.length > 0 || notesText.length > 0;
    if (!hasContent) emptySlides += 1;

    parts.push(block);
    const charStart = cursor;
    const charEnd = cursor + block.length;
    pages.push({ pageNumber: slideNumber, charStart, charEnd });
    cursor = charEnd + 2; // "\n\n" between slides
  }

  if (emptySlides > 0) notes.push(`${emptySlides} slide(s) had no text`);

  return {
    markdown: parts.join('\n\n'),
    pages,
    meta: {
      source: 'pptx',
      quality: emptySlides === slideFiles.length ? 0.2 : 0.9,
      notes,
    },
  };
}

/**
 * Pull every text run (`<a:t>`) from a slide XML, joined with newlines so
 * the chunker gets clean paragraphs. We use a depth-first walk rather than
 * XPath because the XML structure varies across PowerPoint versions.
 */
function extractTextRuns(xml: string, parser: XMLParser): string {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return '';
  }
  const runs: string[] = [];
  walkForTextRuns(parsed, runs);
  // Merge consecutive runs with a single space (they come from the same para),
  // but preserve paragraph boundaries detected via <a:p> nesting.
  return runs.join('\n').replace(/[ \t]+/g, ' ').trim();
}

function walkForTextRuns(node: unknown, out: string[], paraBoundary = false): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (node.trim()) out.push(node);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkForTextRuns(item, out, paraBoundary);
    return;
  }

  const obj = node as Record<string, unknown>;
  // `a:t` = text run in DrawingML. Its child (or #text) is the actual string.
  if ('a:t' in obj) {
    const t = obj['a:t'];
    if (typeof t === 'string') {
      if (t.trim()) out.push(t);
    } else if (typeof t === 'object' && t !== null && '#text' in t) {
      const val = (t as Record<string, unknown>)['#text'];
      if (typeof val === 'string' && val.trim()) out.push(val);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'a:t') continue;
    // `a:p` = paragraph — each one should be a newline in the output.
    if (key === 'a:p' && Array.isArray(value)) {
      for (const p of value) {
        const before = out.length;
        walkForTextRuns(p, out, true);
        if (out.length > before) out.push('');
      }
    } else {
      walkForTextRuns(value, out, paraBoundary);
    }
  }
}

async function loadNotesForSlide(
  zip: JSZip,
  slideNumber: number,
  parser: XMLParser,
): Promise<string> {
  const notesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
  const file = zip.file(notesPath);
  if (!file) return '';
  const xml = await file.async('string');
  const text = extractTextRuns(xml, parser);
  // Notes often include a default "Click to add notes" placeholder from
  // PowerPoint; strip anything that's just that.
  return text.replace(/Click to add notes/gi, '').trim();
}

function bySlideNumber(a: string, b: string): number {
  const na = Number(a.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
  const nb = Number(b.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
  return na - nb;
}
