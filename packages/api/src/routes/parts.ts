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

  // Resources attached to a single part, scoped to a specific asset instance.
  // We scope by the instance's pinned ContentPackVersion so docs from other
  // versions don't leak in — each version has its own explicit author-curated
  // links, which is the whole point of authoring these at the version level.
  app.get<{
    Params: { partId: string };
    Querystring: { assetInstanceId: string };
  }>(
    '/parts/:partId/resources',
    {
      schema: {
        params: z.object({ partId: UuidSchema }),
        querystring: z.object({ assetInstanceId: UuidSchema }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const { partId } = request.params;

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.query.assetInstanceId),
      });
      if (!instance) return reply.notFound('Asset instance not found.');
      const pinnedVersionId = instance.pinnedContentPackVersionId;

      const part = await db.query.parts.findFirst({
        where: eq(schema.parts.id, partId),
      });
      if (!part) return reply.notFound('Part not found.');

      // No pinned version = no authored resources to show. Return the part
      // info alone so the PWA can still render the detail view.
      if (!pinnedVersionId) {
        return {
          part: mapPart(part, storage),
          documents: [],
          trainingModules: [],
        };
      }

      // Join part_documents → documents → filter to pinned version. Same for
      // training. Two small queries — fine at this scale; if it grows we can
      // fold into a single JOIN.
      const [docLinks, moduleLinks] = await Promise.all([
        db.query.partDocuments.findMany({
          where: eq(schema.partDocuments.partId, partId),
        }),
        db.query.partTrainingModules.findMany({
          where: eq(schema.partTrainingModules.partId, partId),
        }),
      ]);

      const docIds = [...new Set(docLinks.map((l) => l.documentId))];
      const moduleIds = [...new Set(moduleLinks.map((l) => l.trainingModuleId))];

      const [linkedDocs, linkedModules] = await Promise.all([
        docIds.length > 0
          ? db.query.documents.findMany({
              where: inArray(schema.documents.id, docIds),
            })
          : Promise.resolve([] as Array<typeof schema.documents.$inferSelect>),
        moduleIds.length > 0
          ? db.query.trainingModules.findMany({
              where: inArray(schema.trainingModules.id, moduleIds),
            })
          : Promise.resolve([] as Array<typeof schema.trainingModules.$inferSelect>),
      ]);

      // Filter to the pinned version — docs/modules from other versions
      // aren't authored for this instance's pinned state.
      const documents = linkedDocs
        .filter((d) => d.contentPackVersionId === pinnedVersionId)
        .map((d) => ({
          id: d.id,
          title: d.title,
          kind: d.kind,
          safetyCritical: d.safetyCritical,
          language: d.language,
          orderingHint: d.orderingHint,
        }))
        .sort((a, b) => a.orderingHint - b.orderingHint || a.title.localeCompare(b.title));

      const trainingModules = linkedModules
        .filter((m) => m.contentPackVersionId === pinnedVersionId)
        .map((m) => ({
          id: m.id,
          title: m.title,
          description: m.description,
          estimatedMinutes: m.estimatedMinutes,
          orderingHint: m.orderingHint,
        }))
        .sort((a, b) => a.orderingHint - b.orderingHint || a.title.localeCompare(b.title));

      return {
        part: mapPart(part, storage),
        documents,
        trainingModules,
      };
    },
  );
}

function mapPart(
  p: typeof schema.parts.$inferSelect,
  storage: { publicUrl: (key: string) => string },
): {
  id: string;
  oemPartNumber: string;
  displayName: string;
  description: string | null;
  crossReferences: string[];
  discontinued: boolean;
  imageUrl: string | null;
} {
  return {
    id: p.id,
    oemPartNumber: p.oemPartNumber,
    displayName: p.displayName,
    description: p.description,
    crossReferences: p.crossReferences,
    discontinued: p.discontinued,
    imageUrl: p.imageStorageKey ? storage.publicUrl(p.imageStorageKey) : null,
  };
}
