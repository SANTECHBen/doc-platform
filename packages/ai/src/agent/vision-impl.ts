// Concrete `classifyImage` implementation backed by AI Gateway + sharp.
//
// Kept here (not in `tools/vision.ts`) because the tool itself takes a
// `classifyImage` callback via AgentToolContext — letting tests inject a
// stub. This module is the production wiring.

import { gateway } from '@ai-sdk/gateway';
import { generateObject } from 'ai';
import sharp from 'sharp';
import { z } from 'zod';

const ResultSchema = z.object({
  classification: z.enum(['logo', 'hero', 'schematic', 'part_photo', 'screenshot', 'other']),
  description: z.string().max(400),
  dominantColors: z.array(z.string()).max(5),
});

export interface CreateGatewayClassifierOpts {
  model: string;
  /** Max edge in pixels for the downscaled image. Default 1024. */
  maxEdge?: number;
}

export function createGatewayImageClassifier(opts: CreateGatewayClassifierOpts) {
  const maxEdge = opts.maxEdge ?? 1024;
  return async (input: { image: Buffer; contentType: string; hint?: string }) => {
    const downscaled = await sharp(input.image)
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const dataUrl = `data:image/jpeg;base64,${downscaled.toString('base64')}`;
    const out = await generateObject({
      model: gateway(opts.model),
      schema: ResultSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Classify the image. Respond strictly per the schema.' +
                (input.hint ? ` Hint: ${input.hint}` : '') +
                ` (mime: ${input.contentType})`,
            },
            { type: 'image', image: dataUrl },
          ],
        },
      ],
    });
    return out.object;
  };
}
