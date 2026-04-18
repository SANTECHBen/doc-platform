import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';

export async function registerContentRoutes(app: FastifyInstance) {
  // List documents in a pinned ContentPackVersion.
  app.get<{ Params: { versionId: string }; Querystring: { lang?: string } }>(
    '/content-pack-versions/:versionId/documents',
    {
      schema: {
        params: z.object({ versionId: UuidSchema }),
        querystring: z.object({ lang: z.string().length(2).optional() }),
      },
    },
    async (request) => {
      const { db, storage } = app.ctx;
      const lang = request.query.lang ?? 'en';
      const rows = await db.query.documents.findMany({
        where: and(
          eq(schema.documents.contentPackVersionId, request.params.versionId),
          eq(schema.documents.language, lang),
        ),
      });
      return rows
        .sort((a, b) => a.orderingHint - b.orderingHint)
        .map((d) => ({
          id: d.id,
          kind: d.kind,
          title: d.title,
          language: d.language,
          safetyCritical: d.safetyCritical,
          tags: d.tags,
          hasBody: d.bodyMarkdown !== null,
          storageKey: d.storageKey,
          streamPlaybackId: d.streamPlaybackId,
          externalUrl: d.externalUrl,
          originalFilename: d.originalFilename,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          thumbnailUrl: d.thumbnailStorageKey
            ? storage.publicUrl(d.thumbnailStorageKey)
            : null,
        }));
    },
  );

  // Fetch one document's body (markdown or a URL for uploaded/externally-hosted media).
  app.get<{ Params: { id: string } }>(
    '/documents/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
      });
      if (!doc) return reply.notFound();
      return {
        ...doc,
        fileUrl: doc.storageKey ? storage.publicUrl(doc.storageKey) : null,
        thumbnailUrl: doc.thumbnailStorageKey
          ? storage.publicUrl(doc.thumbnailStorageKey)
          : null,
      };
    },
  );
}
