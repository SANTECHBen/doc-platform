// PDF extraction. Two-tier strategy:
//   1. Fast path: `unpdf` pulls the embedded text layer. Works for 95% of born-
//      digital PDFs (manufacturer manuals, operator guides, spec sheets).
//   2. Quality fallback: if the text layer is empty or suspiciously short
//      relative to page count, hand the PDF to Claude, which handles scanned
//      pages, complex tables, and figures natively via its PDF ingestion.
//
// The fallback is gated on content, not content_type — a "PDF" that's actually
// scanned images is still a PDF. We detect this by looking at the text yield.

import { extractText, getDocumentProxy } from 'unpdf';
import Anthropic from '@anthropic-ai/sdk';
import type { ExtractionResult, ExtractedPage } from './types.js';
import { ExtractionError } from './types.js';

// Below this many characters *per page* we treat the text layer as inadequate
// and fall back to Claude. 200 covers short spec pages; scanned pages routinely
// produce 0–30 chars of OCR junk, which is well below this threshold.
const MIN_CHARS_PER_PAGE = 200;

// Claude fallback uses a cheap capable model. We're doing extraction, not
// reasoning — haiku is plenty and keeps costs marginal.
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  const notes: string[] = [];

  // Tier 1: text layer.
  const { text, pageCount, perPage } = await tryTextLayer(buffer);

  const avgPerPage = pageCount > 0 ? text.length / pageCount : 0;
  const textLayerLikelyFine = avgPerPage >= MIN_CHARS_PER_PAGE;

  if (textLayerLikelyFine) {
    const markdown = assembleMarkdownFromPages(perPage);
    const pages = buildPageRanges(perPage);
    return {
      markdown,
      pages,
      meta: {
        source: 'pdf',
        quality: 0.9,
        notes: [`text layer, ${pageCount} pages`, ...notes],
      },
    };
  }

  // Tier 2: Claude fallback. Only run if the key is present — otherwise
  // return what we have and flag it, rather than hard-failing.
  notes.push(
    `text layer thin (${Math.round(avgPerPage)} chars/page); trying Claude fallback`,
  );
  if (!process.env.ANTHROPIC_API_KEY) {
    notes.push('no ANTHROPIC_API_KEY — skipping fallback');
    const markdown = assembleMarkdownFromPages(perPage);
    const pages = buildPageRanges(perPage);
    return {
      markdown,
      pages,
      meta: { source: 'pdf', quality: 0.4, notes },
    };
  }

  try {
    const markdown = await claudePdfFallback(buffer);
    return {
      markdown,
      pages: [], // Claude collapses into a single markdown stream; page ranges lost.
      meta: {
        source: 'pdf',
        quality: 0.85,
        notes: [...notes, 'Claude fallback succeeded'],
      },
    };
  } catch (err) {
    // If Claude fallback fails, serve whatever text we did get — partial is
    // better than nothing. Caller sees quality=0.3 and can surface a warning.
    const markdown = assembleMarkdownFromPages(perPage);
    const pages = buildPageRanges(perPage);
    return {
      markdown,
      pages,
      meta: {
        source: 'pdf',
        quality: 0.3,
        notes: [
          ...notes,
          `Claude fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
      },
    };
  }
}

async function tryTextLayer(buffer: Buffer): Promise<{
  text: string;
  pageCount: number;
  perPage: string[];
}> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const pageCount = pdf.numPages;

    // Extract per-page so we can keep page boundaries for citations.
    const perPage: string[] = [];
    for (let p = 1; p <= pageCount; p += 1) {
      const { text } = await extractText(pdf, { mergePages: false });
      // unpdf returns the full array when mergePages=false; grab the one we want.
      // The API shape differs by version; handle both.
      if (Array.isArray(text)) {
        perPage.push(text[p - 1] ?? '');
      } else if (p === 1) {
        // Older behavior returned a single string; we already have it all.
        perPage.push(text);
        for (let i = 2; i <= pageCount; i += 1) perPage.push('');
        break;
      }
    }
    const total = perPage.join('\n\n');
    return { text: total, pageCount, perPage };
  } catch (err) {
    throw new ExtractionError('unpdf failed to parse PDF', err);
  }
}

/**
 * Ask Claude to transcribe the PDF into clean markdown. Claude's PDF support
 * handles scans, tables, multi-column layouts, and figures (which it describes
 * briefly in prose — useful for RAG retrieval over diagrams).
 */
async function claudePdfFallback(buffer: Buffer): Promise<string> {
  const client = new Anthropic();
  const base64 = buffer.toString('base64');

  // The installed @anthropic-ai/sdk (0.32.x) doesn't type the `document`
  // content block yet. The API accepts it at runtime; cast to bypass the
  // stale type. When the SDK is upgraded, these casts can be removed.
  const message = await client.messages.create({
    model: FALLBACK_MODEL,
    max_tokens: 16_000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          } as any,
          {
            type: 'text',
            text: [
              'Extract this document as clean GitHub-flavored Markdown.',
              'Preserve headings (use #, ##, ###), lists, and tables.',
              'For figures and diagrams, write a one-sentence description in *italics*.',
              'Insert `---` between pages.',
              'Do not add commentary, preambles, or explanations — output the markdown only.',
            ].join(' '),
          },
        ],
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new ExtractionError('Claude fallback returned no text content');
  }
  return textBlock.text.trim();
}

function assembleMarkdownFromPages(perPage: string[]): string {
  // Join with a page break marker so the chunker can attribute chunks to pages
  // even though we collapse to one string.
  return perPage
    .map((p, i) => `<!-- page:${i + 1} -->\n\n${normalizeWhitespace(p)}`)
    .filter((p) => p.trim().length > 0)
    .join('\n\n');
}

function buildPageRanges(perPage: string[]): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  let cursor = 0;
  for (let i = 0; i < perPage.length; i += 1) {
    const header = `<!-- page:${i + 1} -->\n\n`;
    const body = normalizeWhitespace(perPage[i] ?? '');
    if (!body) continue;
    const start = cursor + header.length;
    const end = start + body.length;
    pages.push({ pageNumber: i + 1, charStart: start, charEnd: end });
    cursor = end + 2; // "\n\n" separator between pages
  }
  return pages;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
