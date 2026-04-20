// Structure-aware chunking.
//
// Naive char-based chunking splits mid-sentence and loses the document's
// organization. For RAG over technical manuals, where operators search for
// specific procedures or fault codes, that costs us recall. This chunker:
//
//   1. Walks the markdown, tracking heading context (H1 → H2 → H3).
//   2. Splits at paragraph boundaries, never mid-sentence.
//   3. Emits chunks at or below `maxChars`, never below `minChars`.
//   4. Prepends each chunk with a *context header* — the document title plus
//      the current heading path — so embeddings carry topical context even
//      when the raw paragraph is terse.
//   5. Tracks source offsets for citation.
//   6. Associates each chunk with its page number when a page map is given
//      (PDF / PPTX).
//
// The contextual header trick (sometimes called "contextual retrieval") is
// the single biggest quality lever after the reranker. A chunk like "Torque
// to 45 Nm" becomes useless out of context; prepend "Hitachi FT-MERGE-90 →
// Maintenance → Drive belt → Tensioning" and embedding quality jumps.

import type { ExtractedPage } from './extract/types.js';

export interface ChunkOptions {
  /** Soft target for chunk size. Optimal for voyage-3 is ~400-800 tokens. */
  maxChars: number;
  /** Minimum chunk size to emit. Smaller tails are merged into their predecessor. */
  minChars: number;
  /** Document title (shown in the context header of every chunk). */
  documentTitle: string;
  /** Page map from the extractor, if available. */
  pages?: ExtractedPage[];
}

export interface Chunk {
  /** Fully-contextualized chunk text (what goes into the embedding + FTS index). */
  content: string;
  /** Raw text without the context header — what gets shown back to the user. */
  rawContent: string;
  /** Start offset in the source markdown (for citation). */
  charStart: number;
  /** End offset (exclusive) in the source markdown. */
  charEnd: number;
  /** Page number if the source had a page model; null otherwise. */
  page: number | null;
  /** Hierarchical section path at the time this chunk was emitted. */
  sectionPath: string[];
}

export const DEFAULT_CHUNK_OPTIONS = {
  maxChars: 1500,
  minChars: 100,
};

export function chunkMarkdown(markdown: string, opts: ChunkOptions): Chunk[] {
  const { maxChars, minChars, documentTitle, pages = [] } = opts;

  // Break the markdown into blocks (headings + paragraphs + list clusters).
  // Headings drive the section path; other blocks accumulate into chunks.
  const blocks = parseBlocks(markdown);

  const chunks: Chunk[] = [];
  const sectionPath: string[] = []; // Mutable stack of headings currently in scope.
  let buffer = '';
  let bufferStart = 0;
  let bufferEnd = 0;
  let bufferSectionPath: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length < minChars && chunks.length > 0) {
      // Merge tiny tail into the previous chunk if possible.
      const prev = chunks[chunks.length - 1]!;
      prev.rawContent = prev.rawContent + '\n\n' + buffer;
      prev.charEnd = bufferEnd;
      prev.content = buildContextualText(documentTitle, prev.sectionPath, prev.rawContent);
      buffer = '';
      return;
    }
    const content = buildContextualText(documentTitle, bufferSectionPath, buffer);
    const page = pages.length > 0 ? pageForOffset(pages, bufferStart) : null;
    chunks.push({
      content,
      rawContent: buffer,
      charStart: bufferStart,
      charEnd: bufferEnd,
      page,
      sectionPath: [...bufferSectionPath],
    });
    buffer = '';
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // Headings are chunk boundaries — always flush what we have before
      // adjusting the section path.
      flush();
      // Pop any deeper/sibling headings out of scope, then push this one.
      const level = block.level ?? 1;
      while (sectionPath.length >= level) sectionPath.pop();
      sectionPath.push(block.text);
      continue;
    }

    // Non-heading block. If adding it would blow the budget, flush first.
    if (buffer.length > 0 && buffer.length + block.text.length + 2 > maxChars) {
      flush();
    }
    if (buffer.length === 0) {
      buffer = block.text;
      bufferStart = block.charStart;
      bufferEnd = block.charEnd;
      bufferSectionPath = [...sectionPath];
    } else {
      buffer = buffer + '\n\n' + block.text;
      bufferEnd = block.charEnd;
    }

    // One block larger than maxChars? Split it at sentence boundaries.
    if (buffer.length > maxChars) {
      const sentencePieces = splitAtSentenceBoundaries(buffer, maxChars);
      if (sentencePieces.length > 1) {
        // Emit all but the last piece as full chunks.
        let offset = bufferStart;
        for (let i = 0; i < sentencePieces.length - 1; i += 1) {
          const piece = sentencePieces[i]!;
          const content = buildContextualText(documentTitle, bufferSectionPath, piece);
          const page = pages.length > 0 ? pageForOffset(pages, offset) : null;
          chunks.push({
            content,
            rawContent: piece,
            charStart: offset,
            charEnd: offset + piece.length,
            page,
            sectionPath: [...bufferSectionPath],
          });
          offset += piece.length + 1;
        }
        // Keep the tail in the buffer.
        buffer = sentencePieces[sentencePieces.length - 1] ?? '';
        bufferStart = offset;
        bufferEnd = offset + buffer.length;
      }
    }
  }

  flush();

  return chunks;
}

interface Block {
  kind: 'heading' | 'paragraph' | 'list' | 'code' | 'table';
  level?: number; // heading level
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * Lightweight markdown block parser. Good enough for our extractor outputs —
 * we don't aim for full CommonMark fidelity. Recognizes:
 *   - ATX headings (# to ######)
 *   - Fenced code (```)
 *   - List clusters (consecutive - or 1. lines)
 *   - GFM tables (| ... | separator row)
 *   - Plain paragraphs
 */
function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split('\n');
  let cursor = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const lineLen = line.length + 1; // +1 for the newline we stripped

    // Strip synthetic page markers we inject for PDF extraction; they're
    // noise in the chunk text but offsets still track through them.
    if (/^<!--\s*page:\d+\s*-->$/.test(line.trim())) {
      cursor += lineLen;
      i += 1;
      continue;
    }

    // Blank line — skip, advance cursor.
    if (line.trim() === '') {
      cursor += lineLen;
      i += 1;
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      blocks.push({
        kind: 'heading',
        level: h[1]!.length,
        text: h[2]!.trim(),
        charStart: cursor,
        charEnd: cursor + lineLen - 1,
      });
      cursor += lineLen;
      i += 1;
      continue;
    }

    // Fenced code
    if (/^```/.test(line)) {
      const start = cursor;
      const startIdx = i;
      i += 1;
      cursor += lineLen;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        cursor += lines[i]!.length + 1;
        i += 1;
      }
      if (i < lines.length) {
        cursor += lines[i]!.length + 1;
        i += 1;
      }
      const text = lines.slice(startIdx, i).join('\n');
      blocks.push({ kind: 'code', text, charStart: start, charEnd: cursor - 1 });
      continue;
    }

    // GFM table — header + separator + body rows.
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\|[\s:-]+\|/.test(lines[i + 1]!)) {
      const start = cursor;
      const startIdx = i;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        cursor += lines[i]!.length + 1;
        i += 1;
      }
      const text = lines.slice(startIdx, i).join('\n');
      blocks.push({ kind: 'table', text, charStart: start, charEnd: cursor - 1 });
      continue;
    }

    // List cluster (bullets or numbered, possibly indented continuations).
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const start = cursor;
      const startIdx = i;
      while (
        i < lines.length &&
        (lines[i]!.trim() === '' ||
          /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!) ||
          /^\s{2,}/.test(lines[i]!))
      ) {
        cursor += lines[i]!.length + 1;
        i += 1;
        // Stop at a blank line followed by a non-list line (ends the cluster).
        if (i < lines.length && lines[i - 1]!.trim() === '' && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? '')) {
          break;
        }
      }
      const text = lines.slice(startIdx, i).join('\n').replace(/\n+$/, '');
      blocks.push({ kind: 'list', text, charStart: start, charEnd: cursor - 1 });
      continue;
    }

    // Paragraph — run until blank line or structured block.
    const start = cursor;
    const startIdx = i;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('|') &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)
    ) {
      cursor += lines[i]!.length + 1;
      i += 1;
    }
    const text = lines.slice(startIdx, i).join('\n').trim();
    if (text) {
      blocks.push({ kind: 'paragraph', text, charStart: start, charEnd: cursor - 1 });
    }
  }

  return blocks;
}

/**
 * Prepend the document title + section path to the chunk body. This is what
 * gets embedded and FTS-indexed — embedding models weigh these leading
 * tokens heavily, so the section context dramatically improves retrieval.
 *
 * The raw body is preserved separately so we can display the exact source
 * text when citing.
 */
function buildContextualText(
  documentTitle: string,
  sectionPath: string[],
  body: string,
): string {
  const breadcrumb =
    sectionPath.length > 0 ? `${documentTitle} → ${sectionPath.join(' → ')}` : documentTitle;
  return `${breadcrumb}\n\n${body}`;
}

function pageForOffset(pages: ExtractedPage[], offset: number): number | null {
  for (const p of pages) {
    if (offset >= p.charStart && offset < p.charEnd) return p.pageNumber;
  }
  // Offset past the last recorded page — attribute to the final page.
  const last = pages[pages.length - 1];
  return last ? last.pageNumber : null;
}

/**
 * Split an oversized paragraph at sentence boundaries, keeping each piece
 * ≤ maxChars. Falls back to hard-splitting if there are no sentence breaks.
 */
function splitAtSentenceBoundaries(text: string, maxChars: number): string[] {
  // Simple sentence splitter — good enough for the technical prose we handle.
  // Splits on `. ` / `! ` / `? ` / `.\n` followed by whitespace + capital.
  const pieces: string[] = [];
  let buffer = '';
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  for (const s of sentences) {
    if (buffer.length + s.length + 1 <= maxChars) {
      buffer = buffer ? buffer + ' ' + s : s;
    } else {
      if (buffer) pieces.push(buffer);
      if (s.length <= maxChars) {
        buffer = s;
      } else {
        // Sentence itself too long — hard-cut.
        for (let idx = 0; idx < s.length; idx += maxChars) {
          pieces.push(s.slice(idx, idx + maxChars));
        }
        buffer = '';
      }
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}
