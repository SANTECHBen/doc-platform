import { z } from 'zod';
import { UuidSchema } from './ids';

export const AICitationSchema = z.object({
  documentId: UuidSchema,
  contentPackVersionId: UuidSchema,
  quote: z.string(),
  charStart: z.number().int().optional(),
  charEnd: z.number().int().optional(),
  page: z.number().int().optional(),
});
export type AICitation = z.infer<typeof AICitationSchema>;

export const AIChatRequestSchema = z.object({
  // Grounding is always asset-scoped. The server pins the conversation to the
  // AssetInstance's current ContentPackVersion at creation.
  assetInstanceId: UuidSchema,
  // Optional: continue an existing conversation.
  conversationId: UuidSchema.optional(),
  // Either a text message, an attached image, or both.
  message: z.string().max(4000).optional().default(''),
  // Storage key for an image uploaded via /admin/uploads. The server
  // constructs the URL and sends it to Claude as a vision input.
  imageStorageKey: z.string().max(400).optional(),
  // Optional: user language (ISO 639-1). Defaults to server-resolved user preference.
  language: z
    .string()
    .length(2)
    .optional(),
  // Optional: scope retrieval to a specific part. When set, only chunks from
  // documents author-linked to this part (via part_documents) are retrieved.
  // Used by the PWA part-detail hub's Assistant tab so answers cite only the
  // docs explicitly curated for that part.
  partId: UuidSchema.optional(),
}).refine((b) => b.message.trim().length > 0 || !!b.imageStorageKey, {
  message: 'Provide a message, an image, or both.',
});
export type AIChatRequest = z.infer<typeof AIChatRequestSchema>;

export const AIChatResponseChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), conversationId: UuidSchema }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('citations'), citations: z.array(AICitationSchema) }),
  z.object({
    type: z.literal('done'),
    messageId: UuidSchema,
    usage: z.object({
      inputTokens: z.number().int(),
      cachedInputTokens: z.number().int().optional(),
      outputTokens: z.number().int(),
    }),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AIChatResponseChunk = z.infer<typeof AIChatResponseChunkSchema>;
