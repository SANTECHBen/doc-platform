// Vision tool — classifies an image (logo, hero, schematic, part photo, etc.)
// using the AI Gateway's vision API. The actual gateway call is injected via
// AgentToolContext.classifyImage, which downscales and sends a base64 payload
// — keeping costs predictable and tests easy.

import { tool } from 'ai';
import { z } from 'zod';
import type { AgentToolContext } from './context.js';

export function classifyImageTool(ctx: AgentToolContext) {
  return tool({
    description:
      "Classify an image file (PNG/JPG/SVG) from the manifest. Returns one of: logo, hero, schematic, part_photo, screenshot, other — plus a short description and the dominant color palette. Use to decide whether an image should become a logo, an asset_model hero, a part image, or a schematic document. Don't use for non-image files.",
    inputSchema: z.object({
      relativePath: z.string().min(1),
      hint: z
        .string()
        .nullish()
        .describe(
          'Optional hint for the classifier (e.g. "this file is in the parts/ folder, expected: part_photo")',
        ),
    }),
    execute: async ({ relativePath, hint }) => {
      ctx.emitEvent({
        type: 'tool_call',
        data: { name: 'classifyImage', input: { relativePath, hint } },
      });
      const stat = await ctx.statFile(relativePath);
      if (!stat) {
        return { ok: false as const, error: `File not found: ${relativePath}` };
      }
      if (
        !stat.contentType ||
        !/^image\/(png|jpe?g|webp|svg\+xml)/i.test(stat.contentType)
      ) {
        return {
          ok: false as const,
          error: `Not a supported image type: ${stat.contentType ?? 'unknown'}`,
        };
      }
      const buffer = await ctx.readFile(relativePath);
      if (!buffer) {
        return { ok: false as const, error: `File not yet uploaded` };
      }
      try {
        const result = await ctx.classifyImage({
          image: buffer,
          contentType: stat.contentType,
          hint: hint ?? undefined,
        });
        ctx.emitEvent({
          type: 'tool_result',
          data: { name: 'classifyImage', classification: result.classification },
        });
        return { ok: true as const, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  });
}
