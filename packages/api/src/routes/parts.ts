import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';

export async function registerPartsRoutes(app: FastifyInstance) {
  // Flat BOM listing for an asset model — part metadata joined with
  // position refs and quantities from the bom_entries table.
  app.get<{ Params: { modelId: string } }>(
    '/asset-models/:modelId/parts',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request) => {
      const { db, storage } = app.ctx;
      const entries = await db.query.bomEntries.findMany({
        where: eq(schema.bomEntries.assetModelId, request.params.modelId),
      });
      if (entries.length === 0) return [];

      const parts = await db.query.parts.findMany({
        where: inArray(
          schema.parts.id,
          [...new Set(entries.map((e) => e.partId))],
        ),
      });
      const partById = new Map(parts.map((p) => [p.id, p]));

      return entries.map((e) => {
        const p = partById.get(e.partId);
        return {
          bomEntryId: e.id,
          partId: e.partId,
          positionRef: e.positionRef,
          quantity: e.quantity,
          notes: e.notes,
          oemPartNumber: p?.oemPartNumber ?? null,
          displayName: p?.displayName ?? 'Unknown part',
          description: p?.description ?? null,
          crossReferences: p?.crossReferences ?? [],
          discontinued: p?.discontinued ?? false,
          imageUrl: p?.imageStorageKey ? storage.publicUrl(p.imageStorageKey) : null,
        };
      });
    },
  );
}
