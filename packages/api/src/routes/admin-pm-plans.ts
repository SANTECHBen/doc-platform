// Admin authoring API for PM Plans — the checklist-style maintenance
// plans with per-row frequency. Distinct from admin-pm.ts which manages
// flat per-procedure PM schedules; the two coexist.
//
// Surface:
//   GET    /admin/asset-models/:modelId/pm-plans           list plans + items
//   POST   /admin/asset-models/:modelId/pm-plans           create plan (name + optional description)
//   PATCH  /admin/pm-plans/:planId                         rename / toggle disabled / reorder
//   DELETE /admin/pm-plans/:planId                         hard delete (items cascade; service records survive via set null)
//   POST   /admin/pm-plans/:planId/items                   add row
//   PATCH  /admin/pm-plan-items/:itemId                    edit row
//   DELETE /admin/pm-plan-items/:itemId                    drop row
//   POST   /admin/pm-plans/:planId/items/reorder           bulk reorder
//
// All writes scoped to the model's owner org, same as admin-pm.ts.

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';

// ---------------------------------------------------------------------------
// Zod request schemas
// ---------------------------------------------------------------------------

const FrequencyEnum = z.enum(['D', 'W', 'M', 'Q', 'S', 'Y']);

const CreatePlanBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  disabled: z.boolean().default(false),
});

const UpdatePlanBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    orderingHint: z.number().int().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const CreateItemBody = z.object({
  component: z.string().min(1).max(200),
  checkText: z.string().min(1).max(1000),
  remarks: z.string().max(2000).nullable().optional(),
  frequency: FrequencyEnum,
  documentId: UuidSchema.nullable().optional(),
  orderingHint: z.number().int().optional(),
});

const UpdateItemBody = z
  .object({
    component: z.string().min(1).max(200).optional(),
    checkText: z.string().min(1).max(1000).optional(),
    remarks: z.string().max(2000).nullable().optional(),
    frequency: FrequencyEnum.optional(),
    documentId: UuidSchema.nullable().optional(),
    orderingHint: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const ReorderBody = z.object({
  orderedIds: z.array(UuidSchema).min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function loadPlanForWrite(
  db: Database,
  planId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  plan: typeof schema.pmPlans.$inferSelect;
  model: typeof schema.assetModels.$inferSelect;
} | null> {
  const p = await db.query.pmPlans.findFirst({
    where: eq(schema.pmPlans.id, planId),
  });
  if (!p) return null;
  const m = await loadModelForWrite(db, p.assetModelId, scope);
  if (!m) return null;
  return { plan: p, model: m };
}

async function loadItemForWrite(
  db: Database,
  itemId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  item: typeof schema.pmPlanItems.$inferSelect;
  plan: typeof schema.pmPlans.$inferSelect;
} | null> {
  const i = await db.query.pmPlanItems.findFirst({
    where: eq(schema.pmPlanItems.id, itemId),
  });
  if (!i) return null;
  const ctx = await loadPlanForWrite(db, i.planId, scope);
  if (!ctx) return null;
  return { item: i, plan: ctx.plan };
}

function planToDTO(p: typeof schema.pmPlans.$inferSelect) {
  return {
    id: p.id,
    assetModelId: p.assetModelId,
    name: p.name,
    description: p.description,
    orderingHint: p.orderingHint,
    disabled: p.disabled,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function itemToDTO(
  i: typeof schema.pmPlanItems.$inferSelect & {
    document?: { id: string; title: string; kind: string } | null;
  },
) {
  return {
    id: i.id,
    planId: i.planId,
    component: i.component,
    checkText: i.checkText,
    remarks: i.remarks,
    frequency: i.frequency,
    documentId: i.documentId,
    document: i.document ?? null,
    orderingHint: i.orderingHint,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminPmPlans(app: FastifyInstance) {
  const { db } = app.ctx;

  // GET /admin/asset-models/:modelId/pm-plans
  app.get<{ Params: { modelId: string } }>(
    '/admin/asset-models/:modelId/pm-plans',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const m = await loadModelForWrite(db, request.params.modelId, scope);
      if (!m) return reply.notFound();

      const plans = await db.query.pmPlans.findMany({
        where: eq(schema.pmPlans.assetModelId, m.id),
        orderBy: [asc(schema.pmPlans.orderingHint), asc(schema.pmPlans.createdAt)],
      });
      if (plans.length === 0) return [];

      const items = await db.query.pmPlanItems.findMany({
        where: inArray(
          schema.pmPlanItems.planId,
          plans.map((p) => p.id),
        ),
        orderBy: [
          asc(schema.pmPlanItems.orderingHint),
          asc(schema.pmPlanItems.createdAt),
        ],
        with: {
          document: { columns: { id: true, title: true, kind: true } },
        },
      });
      const itemsByPlan = new Map<
        string,
        Array<ReturnType<typeof itemToDTO>>
      >();
      for (const it of items) {
        const arr = itemsByPlan.get(it.planId) ?? [];
        arr.push(itemToDTO(it));
        itemsByPlan.set(it.planId, arr);
      }
      return plans.map((p) => ({
        ...planToDTO(p),
        items: itemsByPlan.get(p.id) ?? [],
      }));
    },
  );

  // POST /admin/asset-models/:modelId/pm-plans
  app.post<{
    Params: { modelId: string };
    Body: z.infer<typeof CreatePlanBody>;
  }>(
    '/admin/asset-models/:modelId/pm-plans',
    {
      schema: {
        params: z.object({ modelId: UuidSchema }),
        body: CreatePlanBody,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const m = await loadModelForWrite(db, request.params.modelId, scope);
      if (!m) return reply.notFound();

      const existing = await db.query.pmPlans.findMany({
        where: eq(schema.pmPlans.assetModelId, m.id),
        columns: { orderingHint: true },
      });
      const max = existing.reduce(
        (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
        0,
      );
      const [created] = await db
        .insert(schema.pmPlans)
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
      return { ...planToDTO(created), items: [] };
    },
  );

  // PATCH /admin/pm-plans/:planId
  app.patch<{
    Params: { planId: string };
    Body: z.infer<typeof UpdatePlanBody>;
  }>(
    '/admin/pm-plans/:planId',
    {
      schema: {
        params: z.object({ planId: UuidSchema }),
        body: UpdatePlanBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadPlanForWrite(db, request.params.planId, scope);
      if (!ctx) return reply.notFound();
      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = b.name.trim();
      if (b.description !== undefined) patch.description = b.description;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.disabled !== undefined) patch.disabled = b.disabled;
      const [updated] = await db
        .update(schema.pmPlans)
        .set(patch)
        .where(eq(schema.pmPlans.id, ctx.plan.id))
        .returning();
      if (!updated) return reply.internalServerError();
      return planToDTO(updated);
    },
  );

  // DELETE /admin/pm-plans/:planId
  app.delete<{ Params: { planId: string } }>(
    '/admin/pm-plans/:planId',
    { schema: { params: z.object({ planId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadPlanForWrite(db, request.params.planId, scope);
      if (!ctx) return reply.notFound();
      await db
        .delete(schema.pmPlans)
        .where(eq(schema.pmPlans.id, ctx.plan.id));
      return { ok: true };
    },
  );

  // POST /admin/pm-plans/:planId/items
  app.post<{
    Params: { planId: string };
    Body: z.infer<typeof CreateItemBody>;
  }>(
    '/admin/pm-plans/:planId/items',
    {
      schema: {
        params: z.object({ planId: UuidSchema }),
        body: CreateItemBody,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadPlanForWrite(db, request.params.planId, scope);
      if (!ctx) return reply.notFound();

      // If a document is referenced, verify it's a structured_procedure
      // on the same owner org (don't let a malformed payload link to
      // someone else's doc).
      if (request.body.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(schema.documents.id, request.body.documentId),
          with: { packVersion: { with: { pack: true } } },
        });
        if (!doc) return reply.badRequest('documentId not found.');
        if (doc.kind !== 'structured_procedure') {
          return reply.badRequest(
            'Only structured_procedure documents can be linked to a plan item.',
          );
        }
        if (
          doc.packVersion.pack.ownerOrganizationId !==
          ctx.model.ownerOrganizationId
        ) {
          return reply.badRequest(
            'Document and plan are owned by different organizations.',
          );
        }
      }

      let orderingHint = request.body.orderingHint;
      if (orderingHint === undefined) {
        const existing = await db.query.pmPlanItems.findMany({
          where: eq(schema.pmPlanItems.planId, ctx.plan.id),
          columns: { orderingHint: true },
        });
        const max = existing.reduce(
          (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
          0,
        );
        orderingHint = max + 100;
      }

      const [created] = await db
        .insert(schema.pmPlanItems)
        .values({
          planId: ctx.plan.id,
          component: request.body.component.trim(),
          checkText: request.body.checkText.trim(),
          remarks: request.body.remarks ?? null,
          frequency: request.body.frequency,
          documentId: request.body.documentId ?? null,
          orderingHint,
          createdByUserId: auth.userId,
        })
        .returning();
      if (!created) return reply.internalServerError();
      // Re-fetch with the doc join so the DTO can include the title.
      const full = await db.query.pmPlanItems.findFirst({
        where: eq(schema.pmPlanItems.id, created.id),
        with: {
          document: { columns: { id: true, title: true, kind: true } },
        },
      });
      return full ? itemToDTO(full) : itemToDTO(created);
    },
  );

  // PATCH /admin/pm-plan-items/:itemId
  app.patch<{
    Params: { itemId: string };
    Body: z.infer<typeof UpdateItemBody>;
  }>(
    '/admin/pm-plan-items/:itemId',
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
            'Only structured_procedure documents can be linked to a plan item.',
          );
        }
      }

      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.component !== undefined) patch.component = b.component.trim();
      if (b.checkText !== undefined) patch.checkText = b.checkText.trim();
      if (b.remarks !== undefined) patch.remarks = b.remarks;
      if (b.frequency !== undefined) patch.frequency = b.frequency;
      if (b.documentId !== undefined) patch.documentId = b.documentId;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      const [updated] = await db
        .update(schema.pmPlanItems)
        .set(patch)
        .where(eq(schema.pmPlanItems.id, ctx.item.id))
        .returning();
      if (!updated) return reply.internalServerError();
      const full = await db.query.pmPlanItems.findFirst({
        where: eq(schema.pmPlanItems.id, updated.id),
        with: {
          document: { columns: { id: true, title: true, kind: true } },
        },
      });
      return full ? itemToDTO(full) : itemToDTO(updated);
    },
  );

  // DELETE /admin/pm-plan-items/:itemId
  app.delete<{ Params: { itemId: string } }>(
    '/admin/pm-plan-items/:itemId',
    { schema: { params: z.object({ itemId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadItemForWrite(db, request.params.itemId, scope);
      if (!ctx) return reply.notFound();
      await db
        .delete(schema.pmPlanItems)
        .where(eq(schema.pmPlanItems.id, ctx.item.id));
      return { ok: true };
    },
  );

  // POST /admin/pm-plans/:planId/items/reorder
  app.post<{
    Params: { planId: string };
    Body: z.infer<typeof ReorderBody>;
  }>(
    '/admin/pm-plans/:planId/items/reorder',
    {
      schema: {
        params: z.object({ planId: UuidSchema }),
        body: ReorderBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadPlanForWrite(db, request.params.planId, scope);
      if (!ctx) return reply.notFound();

      // Verify all IDs belong to this plan.
      const rows = await db.query.pmPlanItems.findMany({
        where: and(
          eq(schema.pmPlanItems.planId, ctx.plan.id),
          inArray(schema.pmPlanItems.id, request.body.orderedIds),
        ),
        columns: { id: true },
      });
      if (rows.length !== request.body.orderedIds.length) {
        return reply.badRequest(
          'orderedIds contains IDs not on this plan, or duplicates.',
        );
      }
      let i = 0;
      for (const id of request.body.orderedIds) {
        i += 1;
        await db
          .update(schema.pmPlanItems)
          .set({ orderingHint: i * 100, updatedAt: new Date() })
          .where(eq(schema.pmPlanItems.id, id));
      }
      return { ok: true, count: request.body.orderedIds.length };
    },
  );
}
