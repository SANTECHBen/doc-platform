// PDF extraction via Claude's native document ingestion.
//
// Rather than run a JS text-layer extractor (unpdf / pdfjs-dist) and fall back
// to an LLM for scanned/complex pages, we just send every PDF to Claude. This
// is:
//   - Simpler — one code path, no library incompatibilities.
//   - Higher quality — Claude handles scans, tables, multi-column layouts,
//     and figures (which it describes in prose, useful for RAG).
//   - Comparable in cost — haiku at ~$0.25/1M input tokens × a 10-page PDF ≈
//     $0.001. Well under the budget for the quality lift.
//
// If ANTHROPIC_API_KEY is missing the function throws, because without it we
// have no way to extract anything at all.

import Anthropic from '@anthropic-ai/sdk';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';

// Haiku is more than capable for transcription. Reserving Sonnet/Opus here
// would be overkill and burn budget.
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ExtractionError('ANTHROPIC_API_KEY is not set — cannot extract PDFs');
  }

  // Anthropic accepts PDFs up to 32MB as base64. If the upload was larger,
  // extraction fails loudly rather than silently truncating.
  const maxBytes = 32 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new ExtractionError(
      `PDF is ${Math.round(buffer.length / 1024 / 1024)}MB — over Anthropic's 32MB limit`,
    );
  }

  const client = new Anthropic();
  const base64 = buffer.toString('base64');

  let message;
  try {
    // SDK 0.32 doesn't type the `document` content block yet. The API accepts
    // it at runtime; cast to bypass the stale type until the SDK is upgraded.
    message = await client.messages.create({
      model: EXTRACTION_MODEL,
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
                'Extract the full text of this PDF as clean GitHub-flavored Markdown.',
                'Preserve document structure — headings become #, ##, ###; lists become - or 1.; tables become GFM tables.',
                'For figures and diagrams, write a one-sentence description in *italics* so retrieval can match questions about them.',
                'Insert `<!-- page:N -->` at the start of each page so citations can reference specific pages.',
                'Output the markdown only — no preamble, explanation, or commentary.',
              ].join(' '),
            },
          ],
        },
      ],
    });
  } catch (err) {
    throw new ExtractionError(
      `Claude PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new ExtractionError('Claude returned no text content for PDF');
  }

  const markdown = textBlock.text.trim();
  if (markdown.length === 0) {
    throw new ExtractionError('Claude returned empty markdown for PDF');
  }

  // Pull page ranges from the <!-- page:N --> markers we asked Claude to insert.
  // If it didn't emit them (short doc, one page), pages stays empty and the
  // chunker falls back to section-based attribution.
  const pages = parsePageMarkers(markdown);

  return {
    markdown,
    pages,
    meta: {
      source: 'pdf',
      quality: 0.9,
      notes: [`extracted via Claude (${EXTRACTION_MODEL})`],
    },
  };
}

function parsePageMarkers(markdown: string): Array<{
  pageNumber: number;
  charStart: number;
  charEnd: number;
}> {
  const pages: Array<{ pageNumber: number; charStart: number; charEnd: number }> = [];
  const re = /<!--\s*page:(\d+)\s*-->/g;
  const matches: Array<{ pageNumber: number; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    matches.push({ pageNumber: Number(m[1]), start: m.index });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.start;
    const end = i + 1 < matches.length ? matches[i + 1]!.start : markdown.length;
    pages.push({ pageNumber: matches[i]!.pageNumber, charStart: start, charEnd: end });
  }
  return pages;
}
