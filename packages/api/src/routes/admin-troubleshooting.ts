// Admin authoring API for Troubleshooting Guides. Mirrors admin-pm-plans.ts —
// guide owns many items, items are inline-edited via a grid in the admin
// UI. Distinct from PM Plans in that there's no frequency/schedule
// concept; troubleshooting is reactive, not scheduled.
//
// Surface:
//   GET    /admin/asset-models/:modelId/troubleshooting-guides
//   POST   /admin/asset-models/:modelId/troubleshooting-guides
//   PATCH  /admin/troubleshooting-guides/:guideId
//   DELETE /admin/troubleshooting-guides/:guideId
//   POST   /admin/troubleshooting-guides/:guideId/items
//   PATCH  /admin/troubleshooting-items/:itemId
//   DELETE /admin/troubleshooting-items/:itemId
//   POST   /admin/troubleshooting-guides/:guideId/items/reorder

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';

const CreateGuideBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  disabled: z.boolean().default(false),
});

const UpdateGuideBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    orderingHint: z.number().int().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

// Structured cause/remedy step. Each item is one entry the tech might
// consider; documentId optionally links to a structured_procedure so the
// row gets its own "Run" button in the PWA. Same shape for both cause
// and remedy — symmetric authoring + rendering.
//
// text allows empty so the admin can commit a blank "+ Add item" row
// before the author types into it (mirrors PM Plan items). The PWA
// filters empty-text rows out of rendering so techs never see blanks.
const StructuredItemSchema = z.object({
  text: z.string().max(1000),
  documentId: UuidSchema.nullable().optional(),
});

const CreateItemBody = z.object({
  symptom: z.string().min(1).max(500),
  // cause/remedy can be empty on create — author types into the row inline.
  cause: z.string().max(2000).nullable().optional(),
  remedy: z.string().max(2000).nullable().optional(),
  causeItems: z.array(StructuredItemSchema).max(30).optional(),
  remedyItems: z.array(StructuredItemSchema).max(30).optional(),
  documentId: UuidSchema.nullable().optional(),
  orderingHint: z.number().int().optional(),
});

const UpdateItemBody = z
  .object({
    symptom: z.string().min(1).max(500).optional(),
    cause: z.string().max(2000).nullable().optional(),
    remedy: z.string().max(2000).nullable().optional(),
    causeItems: z.array(StructuredItemSchema).max(30).optional(),
    remedyItems: z.array(StructuredItemSchema).max(30).optional(),
    documentId: UuidSchema.nullable().optional(),
    orderingHint: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const ReorderBody = z.object({
  orderedIds: z.array(UuidSchema).min(1),
});

// Validates that every documentId referenced by a structured cause/remedy
// item is a structured_procedure in the same owner org as the asset
// model. Returns null on success; an error message string on first
// failure. Reusable across POST + PATCH; cheap (one query for all IDs).
async function validateItemDocumentIds(
  db: Database,
  items: Array<{ text: string; documentId?: string | null }> | undefined,
  ownerOrganizationId: string,
): Promise<string | null> {
  if (!items || items.length === 0) return null;
  const ids = [
    ...new Set(
      items
        .map((i) => i.documentId ?? null)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) return null;
  const docs = await db.query.documents.findMany({
    where: inArray(schema.documents.id, ids),
    with: { packVersion: { with: { pack: true } } },
  });
  if (docs.length !== ids.length) {
    return 'One or more linked documentIds were not found.';
  }
  for (const d of docs) {
    if (d.kind !== 'structured_procedure') {
      return 'Only structured_procedure documents can be linked to cause/remedy items.';
    }
    if (d.packVersion.pack.ownerOrganizationId !== ownerOrganizationId) {
      return 'A linked document is owned by a different organization than the troubleshooting guide.';
    }
  }
  return null;
}

async function loadModelForWrite(
  db: Database,
  modelId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<typeof schema.assetModels.$inferSelect | null> {
  const m = await db.query.assetModels.findFirst({
    where: eq(schema.assetModels.id, modelId),
  });
  if (!m) return null;
  requireOrgInScope(scope, m.ownerOrganizationId);
  return m;
}

async function loadGuideForWrite(
  db: Database,
  guideId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  guide: typeof schema.troubleshootingGuides.$inferSelect;
  model: typeof schema.assetModels.$inferSelect;
} | null> {
  const g = await db.query.troubleshootingGuides.findFirst({
    where: eq(schema.troubleshootingGuides.id, guideId),
  });
  if (!g) return null;
  const m = await loadModelForWrite(db, g.assetModelId, scope);
  if (!m) return null;
  return { guide: g, model: m };
}

async function loadItemForWrite(
  db: Database,
  itemId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  item: typeof schema.troubleshootingItems.$inferSelect;
  guide: typeof schema.troubleshootingGuides.$inferSelect;
} | null> {
  const i = await db.query.troubleshootingItems.findFirst({
    where: eq(schema.troubleshootingItems.id, itemId),
  });
  if (!i) return null;
  const ctx = await loadGuideForWrite(db, i.guideId, scope);
  if (!ctx) return null;
  return { item: i, guide: ctx.guide };
}

function guideToDTO(g: typeof schema.troubleshootingGuides.$inferSelect) {
  return {
    id: g.id,
    assetModelId: g.assetModelId,
    name: g.name,
    description: g.description,
    orderingHint: g.orderingHint,
    disabled: g.disabled,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

function itemToDTO(
  i: typeof schema.troubleshootingItems.$inferSelect & {
    document?: { id: string; title: string; kind: string } | null;
  },
) {
  return {
    id: i.id,
    guideId: i.guideId,
    symptom: i.symptom,
    cause: i.cause,
    remedy: i.remedy,
    causeItems: i.causeItems ?? [],
    remedyItems: i.remedyItems ?? [],
    documentId: i.documentId,
    document: i.document ?? null,
    orderingHint: i.orderingHint,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export async function registerAdminTroubleshooting(app: FastifyInstance) {
  const { db } = app.ctx;

  // GET list
  app.get<{ Params: { modelId: string } }>(
    '/admin/asset-models/:modelId/troubleshooting-guides',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const m = await loadModelForWrite(db, request.params.modelId, scope);
      if (!m) return reply.notFound();

      const guides = await db.query.troubleshootingGuides.findMany({
        where: eq(schema.troubleshootingGuides.assetModelId, m.id),
        orderBy: [
          asc(schema.troubleshootingGuides.orderingHint),
          asc(schema.troubleshootingGuides.createdAt),
        ],
      });
      if (guides.length === 0) return [];

      const items = await db.query.troubleshootingItems.findMany({
        where: inArray(
          schema.troubleshootingItems.guideId,
          guides.map((g) => g.id),
        ),
        orderBy: [
          asc(schema.troubleshootingItems.orderingHint),
          asc(schema.troubleshootingItems.createdAt),
        ],
        with: {
          document: { columns: { id: true, title: true, kind: true } },
        },
      });
      const byGuide = new Map<string, Array<ReturnType<typeof itemToDTO>>>();
      for (const it of items) {
        const arr = byGuide.get(it.guideId) ?? [];
        arr.push(itemToDTO(it));
        byGuide.set(it.guideId, arr);
      }
      return guides.map((g) => ({
        ...guideToDTO(g),
        items: byGuide.get(g.id) ?? [],
      }));
    },
  );

  // POST create guide
  app.post<{
    Params: { modelId: string };
    Body: z.infer<typeof CreateGuideBody>;
  }>(
    '/admin/asset-models/:modelId/troubleshooting-guides',
    {
      schema: {
        params: z.object({ modelId: UuidSchema }),
        body: CreateGuideBody,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const m = await loadModelForWrite(db, request.params.modelId, scope);
      if (!m) return reply.notFound();

      const existing = await db.query.troubleshootingGuides.findMany({
        where: eq(schema.troubleshootingGuides.assetModelId, m.id),
        columns: { orderingHint: true },
      });
      const max = existing.reduce(
        (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
        0,
      );
      const [created] = await db
        .insert(schema.troubleshootingGuides)
        .values({
          assetModelId: m.id,
          name: request.body.name.trim(),
          description: request.body.description ?? null,
          disabled: request.body.disabled,
          orderingHint: max + 100,
          createdByUserId: auth.userId,
        })
        .returning();
      if (!created) return reply.internalServerError();
      return { ...guideToDTO(created), items: [] };
    },
  );

  // PATCH guide
  app.patch<{
    Params: { guideId: string };
    Body: z.infer<typeof UpdateGuideBody>;
  }>(
    '/admin/troubleshooting-guides/:guideId',
    {
      schema: {
        params: z.object({ guideId: UuidSchema }),
        body: UpdateGuideBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadGuideForWrite(db, request.params.guideId, scope);
      if (!ctx) return reply.notFound();
      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.description !== undefined) patch.description = b.description;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.disabled !== undefined) patch.disabled = b.disabled;
      const [updated] = await db
        .update(schema.troubleshootingGuides)
        .set(patch)
        .where(eq(schema.troubleshootingGuides.id, ctx.guide.id))
        .returning();
      if (!updated) return reply.internalServerError();
      return guideToDTO(updated);
    },
  );

  // DELETE guide
  app.delete<{ Params: { guideId: string } }>(
    '/admin/troubleshooting-guides/:guideId',
    { schema: { params: z.object({ guideId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadGuideForWrite(db, request.params.guideId, scope);
      if (!ctx) return reply.notFound();
      await db
        .delete(schema.troubleshootingGuides)
        .where(eq(schema.troubleshootingGuides.id, ctx.guide.id));
      return { ok: true };
    },
  );

  // POST create item
  app.post<{
    Params: { guideId: string };
    Body: z.infer<typeof CreateItemBody>;
  }>(
    '/admin/troubleshooting-guides/:guideId/items',
    {
      schema: {
        params: z.object({ guideId: UuidSchema }),
        body: CreateItemBody,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadGuideForWrite(db, request.params.guideId, scope);
      if (!ctx) return reply.notFound();

      if (request.body.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(schema.documents.id, request.body.documentId),
          with: { packVersion: { with: { pack: true } } },
        });
        if (!doc) return reply.badRequest('documentId not found.');
        if (doc.kind !== 'structured_procedure') {
          return reply.badRequest(
            'Only structured_procedure documents can be linked to a troubleshooting item.',
          );
        }
        if (
          doc.packVersion.pack.ownerOrganizationId !==
          ctx.model.ownerOrganizationId
        ) {
          return reply.badRequest(
            'Document and guide are owned by different organizations.',
          );
        }
      }
      // Per-item documentIds inside causeItems / remedyItems share the
      // same rules. One query for all referenced IDs across both lists.
      const itemErr =
        (await validateItemDocumentIds(
          db,
          request.body.causeItems,
          ctx.model.ownerOrganizationId,
        )) ??
        (await validateItemDocumentIds(
          db,
          request.body.remedyItems,
          ctx.model.ownerOrganizationId,
        ));
      if (itemErr) return reply.badRequest(itemErr);

      let orderingHint = request.body.orderingHint;
      if (orderingHint === undefined) {
        const existing = await db.query.troubleshootingItems.findMany({
          where: eq(schema.troubleshootingItems.guideId, ctx.guide.id),
          columns: { orderingHint: true },
        });
        const max = existing.reduce(
          (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
          0,
        );
        orderingHint = max + 100;
      }

      const [created] = await db
        .insert(schema.troubleshootingItems)
        .values({
          guideId: ctx.guide.id,
          symptom: request.body.symptom.trim(),
          cause: request.body.cause ?? null,
          remedy: request.body.remedy ?? null,
          causeItems: request.body.causeItems ?? [],
          remedyItems: request.body.remedyItems ?? [],
          documentId: request.body.documentId ?? null,
          orderingHint,
          createdByUserId: auth.userId,
        })
        .returning();
      if (!created) return reply.internalServerError();
      const full = await db.query.troubleshootingItems.findFirst({
        where: eq(schema.troubleshootingItems.id, created.id),
        with: {
          document: { columns: { id: true, title: true, kind: true } },
        },
      });
      return full ? itemToDTO(full) : itemToDTO(created);
    },
  );

  // PATCH item
  app.patch<{
    Params: { itemId: string };
    Body: z.infer<typeof UpdateItemBody>;
  }>(
    '/admin/troubleshooting-items/:itemId',
    {
      schema: {
        params: z.object({ itemId: UuidSchema }),
        body: UpdateItemBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadItemForWrite(db, request.params.itemId, scope);
      if (!ctx) return reply.notFound();
      if (request.body.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(schema.documents.id, request.body.documentId),
          with: { packVersion: { with: { pack: true } } },
        });
        if (!doc) return reply.badRequest('documentId not found.');
        if (doc.kind !== 'structured_procedure') {
          return reply.badRequest(
            'Only structured_procedure documents can be linked to a troubleshooting item.',
          );
        }
      }
      // Per-item documentIds inside causeItems / remedyItems share the
      // same rules as the row-level documentId. Need the model's owner
      // org to scope.
      const model = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, ctx.guide.assetModelId),
        columns: { ownerOrganizationId: true },
      });
      if (model) {
        const itemErr =
          (await validateItemDocumentIds(
            db,
            request.body.causeItems,
            model.ownerOrganizationId,
          )) ??
          (await validateItemDocumentIds(
            db,
            request.body.remedyItems,
            model.ownerOrganizationId,
          ));
        if (itemErr) return reply.badRequest(itemErr);
      }
      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.symptom !== undefined) patch.symptom = b.symptom.trim();
      if (b.cause !== undefined) patch.cause = b.cause;
      if (b.remedy !== undefined) patch.remedy = b.remedy;
      if (b.causeItems !== undefined) patch.causeItems = b.causeItems;
      if (b.remedyItems !== undefined) patch.remedyItems = b.remedyItems;
      if (b.documentId !== undefined) patch.documentId = b.documentId;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      const [updated] = await db
        .update(schema.troubleshootingItems)
        .set(patch)
        .where(eq(schema.troubleshootingItems.id, ctx.item.id))
        .returning();
      if (!updated) return reply.internalServerError();
      const full = await db.query.troubleshootingItems.findFirst({
        where: eq(schema.troubleshootingItems.id, updated.id),
        with: {
          document: { columns: { id: true, title: true, kind: true } },
        },
      });
      return full ? itemToDTO(full) : itemToDTO(updated);
    },
  );

  // DELETE item
  app.delete<{ Params: { itemId: string } }>(
    '/admin/troubleshooting-items/:itemId',
    { schema: { params: z.object({ itemId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadItemForWrite(db, request.params.itemId, scope);
      if (!ctx) return reply.notFound();
      await db
        .delete(schema.troubleshootingItems)
        .where(eq(schema.troubleshootingItems.id, ctx.item.id));
      return { ok: true };
    },
  );

  // POST reorder items
  app.post<{
    Params: { guideId: string };
    Body: z.infer<typeof ReorderBody>;
  }>(
    '/admin/troubleshooting-guides/:guideId/items/reorder',
    {
      schema: {
        params: z.object({ guideId: UuidSchema }),
        body: ReorderBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadGuideForWrite(db, request.params.guideId, scope);
      if (!ctx) return reply.notFound();
      const rows = await db.query.troubleshootingItems.findMany({
        where: and(
          eq(schema.troubleshootingItems.guideId, ctx.guide.id),
          inArray(schema.troubleshootingItems.id, request.body.orderedIds),
        ),
        columns: { id: true },
      });
      if (rows.length !== request.body.orderedIds.length) {
        return reply.badRequest(
          'orderedIds contains IDs not on this guide, or duplicates.',
        );
      }
      let i = 0;
      for (const id of request.body.orderedIds) {
        i += 1;
        await db
          .update(schema.troubleshootingItems)
          .set({ orderingHint: i * 100, updatedAt: new Date() })
          .where(eq(schema.troubleshootingItems.id, id));
      }
      return { ok: true, count: request.body.orderedIds.length };
    },
  );
}
