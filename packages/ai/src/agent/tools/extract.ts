// Extraction tools — let the agent peek inside files in the manifest to
// classify them, propose better titles, or flag safety-critical content.
//
// All extractors are bounded: PDFs are capped at the first N pages, CSVs at
// N rows, free text at N bytes. The agent only needs enough signal to
// classify; it doesn't need the full corpus (the post-execute extraction
// pipeline handles full text for retrieval).

import { tool } from 'ai';
import { z } from 'zod';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { extract as extractDocument } from '../../extract/index.js';
import type { AgentToolContext } from './context.js';

const MAX_TEXT_PREVIEW = 8000;
const MAX_CSV_ROWS_RETURNED = 50;

function sliceText(input: string, max: number = MAX_TEXT_PREVIEW): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n\n[…truncated, ${input.length - max} more chars]`;
}

export function extractPdfTextTool(ctx: AgentToolContext) {
  return tool({
    description:
      "Extract text from a PDF (or DOCX/PPTX) file in the manifest. Returns up to ~8KB of text from the first few pages, plus page count. Use to classify document kind, generate a meaningful title, or detect safety-critical content. Don't use on files you've already extracted in this run.",
    inputSchema: z.object({
      relativePath: z
        .string()
        .min(1)
        .describe('Path of the file in the manifest (relative to the run root)'),
    }),
    execute: async ({ relativePath }) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'extractPdfText', input: { relativePath } },
      });
      const stat = await ctx.statFile(relativePath);
      if (!stat) {
        ctx.emitEvent({
          type: 'tool_result',
          data: { name: 'extractPdfText', error: 'file not in manifest' },
        });
        return { ok: false as const, error: `File not found: ${relativePath}` };
      }
      const buffer = await ctx.readFile(relativePath);
      if (!buffer) {
        ctx.emitEvent({
          type: 'tool_result',
          data: { name: 'extractPdfText', error: 'not uploaded yet' },
        });
        return {
          ok: false as const,
          error: `File not yet uploaded: ${relativePath}`,
        };
      }
      try {
        const result = await extractDocument({
          buffer,
          contentType: stat.contentType,
          filename: relativePath.split('/').pop() ?? '',
        });
        const sample = sliceText(result.markdown);
        ctx.emitEvent({
          type: 'tool_result',
          data: {
            name: 'extractPdfText',
            pageCount: result.pages?.length ?? null,
            sampleChars: sample.length,
          },
        });
        return {
          ok: true as const,
          relativePath,
          contentType: stat.contentType,
          pageCount: result.pages?.length ?? null,
          quality: result.meta.quality ?? null,
          notes: result.meta.notes ?? [],
          textSample: sample,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.emitEvent({
          type: 'tool_result',
          data: { name: 'extractPdfText', error: message },
        });
        return { ok: false as const, error: message };
      }
    },
  });
}

export function readSmallTextFileTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Read a small text file (.md, .txt, .url) from the manifest. Capped at ~8KB. Use for README files, color hex files, link files, or markdown content.',
    inputSchema: z.object({
      relativePath: z.string().min(1),
    }),
    execute: async ({ relativePath }) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'readSmallTextFile', input: { relativePath } },
      });
      const stat = await ctx.statFile(relativePath);
      if (!stat) {
        return { ok: false as const, error: `File not found: ${relativePath}` };
      }
      if (stat.sizeBytes > 256 * 1024) {
        return {
          ok: false as const,
          error: `File too large for readSmallTextFile: ${stat.sizeBytes} bytes`,
        };
      }
      const buffer = await ctx.readFile(relativePath);
      if (!buffer) {
        return { ok: false as const, error: `File not yet uploaded` };
      }
      const text = buffer.toString('utf8');
      ctx.emitEvent({
        type: 'tool_result',
        data: { name: 'readSmallTextFile', chars: text.length },
      });
      return {
        ok: true as const,
        relativePath,
        contentType: stat.contentType,
        text: sliceText(text),
      };
    },
  });
}

export function parseCsvTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Parse a CSV file from the manifest as objects keyed by header row. Returns up to 50 rows. Use for instances.csv, parts.csv, sites.csv, or other tabular data the convention parser missed.',
    inputSchema: z.object({
      relativePath: z.string().min(1),
      expectedColumns: z.array(z.string()).nullish(),
    }),
    execute: async ({ relativePath, expectedColumns }) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'parseCsv', input: { relativePath } },
      });
      const buffer = await ctx.readFile(relativePath);
      if (!buffer) {
        return { ok: false as const, error: `File not found or not uploaded` };
      }
      try {
        const rows = parseCsvSync(buffer.toString('utf8'), {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as Record<string, string>[];
        const head = rows.slice(0, MAX_CSV_ROWS_RETURNED);
        const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
        const missingExpected = expectedColumns
          ? expectedColumns.filter((c) => !headers.includes(c))
          : [];
        ctx.emitEvent({
          type: 'tool_result',
          data: { name: 'parseCsv', rows: rows.length, headers },
        });
        return {
          ok: true as const,
          relativePath,
          rowCount: rows.length,
          headers,
          missingExpected,
          rows: head,
          truncated: rows.length > MAX_CSV_ROWS_RETURNED,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: `CSV parse error: ${message}` };
      }
    },
  });
}
