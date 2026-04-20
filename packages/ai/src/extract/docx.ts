// DOCX extraction. Mammoth converts Word documents into semantic HTML (it
// respects styles — Heading 1 → <h1>, not "bold 18pt"), which we then turn
// into Markdown. Mammoth handles:
//   - headings, lists (bulleted + numbered), nested lists
//   - bold / italic / underline
//   - hyperlinks
//   - tables (rendered as HTML; we convert to GFM markdown)
//   - images (we drop them — retrieval doesn't read image pixels)
//
// Word doesn't have a page model at the file format level; page breaks are
// pagination hints the renderer inserts. So the pages array is empty — the
// chunker will fall back to section boundaries.

import mammoth from 'mammoth';
import type { ExtractionResult } from './types.js';
import { ExtractionError } from './types.js';

export async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const notes: string[] = [];

  try {
    // Convert to semantic HTML, then Markdown. Going through HTML preserves
    // table structure, which direct-to-markdown loses in mammoth.
    const htmlResult = await mammoth.convertToHtml(
      { buffer },
      {
        // Drop images — retrieval can't use them, and keeping them pollutes
        // the chunked text with giant base64 blobs.
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
        styleMap: [
          // Map common Word styles explicitly. Mammoth's defaults handle the
          // basics; we add a few extras that appear in OEM templates.
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Code'] => pre:fresh",
        ],
      },
    );

    if (htmlResult.messages.length > 0) {
      // mammoth emits warnings for unsupported styles etc. Keep them for
      // the admin UI but don't treat as failure.
      notes.push(...htmlResult.messages.slice(0, 3).map((m) => m.message));
      if (htmlResult.messages.length > 3) {
        notes.push(`… and ${htmlResult.messages.length - 3} more warnings`);
      }
    }

    const markdown = htmlToMarkdown(htmlResult.value);

    return {
      markdown,
      pages: [],
      meta: {
        source: 'docx',
        quality: 0.95,
        notes,
      },
    };
  } catch (err) {
    throw new ExtractionError('mammoth failed to parse DOCX', err);
  }
}

/**
 * Minimal HTML → Markdown converter tuned for mammoth's output. Handles
 * headings, lists, tables, bold/italic, links, blockquotes, code.
 * Not a general-purpose HTML→MD — mammoth's output is deliberately narrow.
 */
function htmlToMarkdown(html: string): string {
  let out = html;

  // Headings
  out = out.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n\n# ${stripTags(inner)}\n\n`);
  out = out.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `\n\n## ${stripTags(inner)}\n\n`);
  out = out.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `\n\n### ${stripTags(inner)}\n\n`);
  out = out.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) => `\n\n#### ${stripTags(inner)}\n\n`);
  out = out.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, inner) => `\n\n##### ${stripTags(inner)}\n\n`);
  out = out.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, inner) => `\n\n###### ${stripTags(inner)}\n\n`);

  // Lists. We convert each <li> to a `-` bullet; nested UL/OL are flattened
  // to a single level with indentation. Good enough for retrieval text —
  // perfect nesting isn't needed.
  out = out.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let i = 1;
    return (
      '\n' +
      inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, body: string) => {
        const text = stripTags(body).trim();
        return `${i++}. ${text}\n`;
      }) +
      '\n'
    );
  });
  out = out.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    return (
      '\n' +
      inner.replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (_m: string, body: string) => `- ${stripTags(body).trim()}\n`,
      ) +
      '\n'
    );
  });

  // Tables → GFM. We rebuild the pipe structure row by row.
  out = out.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
    const rows = Array.from(inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) as IterableIterator<
      RegExpMatchArray
    >).map((m) => m[1] ?? '');
    const cellRows = rows.map((r) =>
      Array.from(r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) as IterableIterator<
        RegExpMatchArray
      >).map((m) => stripTags(m[1] ?? '').replace(/\|/g, '\\|').trim()),
    );
    if (cellRows.length === 0) return '';
    const cols = Math.max(...cellRows.map((r) => r.length));
    const lines: string[] = [];
    // Header = first row
    const header = cellRows[0] ?? [];
    lines.push(`| ${padRow(header, cols).join(' | ')} |`);
    lines.push(`| ${Array(cols).fill('---').join(' | ')} |`);
    for (let i = 1; i < cellRows.length; i += 1) {
      lines.push(`| ${padRow(cellRows[i] ?? [], cols).join(' | ')} |`);
    }
    return '\n\n' + lines.join('\n') + '\n\n';
  });

  // Inline formatting
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `**${stripTags(inner)}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `*${stripTags(inner)}*`);
  out = out.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const text = stripTags(inner);
    return href ? `[${text}](${href})` : text;
  });

  // Blockquote + code
  out = out.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const text = stripTags(inner).trim();
    return '\n\n' + text.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
  });
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    return '\n\n```\n' + stripTags(inner).trim() + '\n```\n\n';
  });

  // Paragraphs
  out = out.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n\n${stripTags(inner)}\n\n`);
  out = out.replace(/<br\s*\/?\s*>/gi, '\n');

  // Drop any remaining tags
  out = stripTags(out);

  // Decode entities and collapse whitespace
  out = decodeEntities(out);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function padRow(row: string[], cols: number): string[] {
  const out = [...row];
  while (out.length < cols) out.push('');
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
