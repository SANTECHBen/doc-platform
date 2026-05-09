// Admin authoring API for procedure_steps. Mirrors admin-sections.ts.
//
// Surface:
//   GET    /admin/documents/:documentId/procedure-steps
//   POST   /admin/documents/:documentId/procedure-steps
//   PATCH  /admin/procedure-steps/:stepId
//   DELETE /admin/procedure-steps/:stepId          (409 if completions exist)
//   GET    /admin/procedure-steps/:stepId/parts
//   PUT    /admin/procedure-steps/:stepId/parts    (set-replace)
//   POST   /admin/documents/:documentId/procedure-steps/reorder
//
// All writes are scoped to the document's owner org. Steps are additive
// overlays (like sections) — edits are allowed on published versions so
// authors can keep improving procedures without bumping the pack version.

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { z } from 'zod';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';

// ---------------------------------------------------------------------------
// Zod schemas — request bodies
// ---------------------------------------------------------------------------

const StepKindEnum = z.enum([
  'instruction',
  'safety_check',
  'photo_required',
  'measurement_required',
]);

// Discriminated union for measurement specs. Keep schemas in sync with
// the runtime check in packages/api/src/routes/procedures.ts and the
// MeasurementSpec type in packages/db/src/schema/procedures.ts.
const NumericSpec = z.object({
  kind: z.literal('numeric'),
  label: z.string().min(1).max(120),
  unit: z.string().min(1).max(40),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  expected: z.number().nullable().optional(),
  tolerancePct: z.number().nullable().optional(),
});
const PassFailSpec = z.object({
  kind: z.literal('pass_fail'),
  label: z.string().min(1).max(120),
  passLabel: z.string().max(40).optional(),
  failLabel: z.string().max(40).optional(),
});
const FreeTextSpec = z.object({
  kind: z.literal('free_text'),
  label: z.string().min(1).max(120),
  placeholder: z.string().max(120).optional(),
  maxLen: z.number().int().min(1).max(2000).optional(),
});
const MeasurementSpecSchema = z.discriminatedUnion('kind', [
  NumericSpec,
  PassFailSpec,
  FreeTextSpec,
]);

// Discriminated union for typed step blocks. Mirrors StepBlock in
// packages/db/src/schema/procedures.ts. Server validates the shape so a
// rogue admin client can't persist incoherent rows.
const ParagraphBlock = z.object({
  kind: z.literal('paragraph'),
  text: z.string().max(8000),
});
const CalloutBlock = z.object({
  kind: z.literal('callout'),
  tone: z.enum(['safety', 'warning', 'tip', 'note']),
  title: z.string().max(120).optional(),
  text: z.string().min(1).max(2000),
});
const BulletListBlock = z.object({
  kind: z.literal('bullet_list'),
  items: z.array(z.string().min(1).max(800)).min(1).max(50),
});
const NumberedListBlock = z.object({
  kind: z.literal('numbered_list'),
  items: z.array(z.string().min(1).max(800)).min(1).max(50),
});
const KeyValueBlock = z.object({
  kind: z.literal('key_value'),
  columns: z.tuple([z.string().min(1).max(60), z.string().min(1).max(60)]),
  rows: z
    .array(z.tuple([z.string().min(1).max(200), z.string().min(1).max(200)]))
    .min(1)
    .max(60),
});
const PhotoInlineBlock = z.object({
  kind: z.literal('photo_inline'),
  storageKey: z.string().min(1).max(400),
  caption: z.string().max(400).optional(),
});
const StepBlockSchema = z.discriminatedUnion('kind', [
  ParagraphBlock,
  CalloutBlock,
  BulletListBlock,
  NumberedListBlock,
  KeyValueBlock,
  PhotoInlineBlock,
]);
const BlocksArraySchema = z.array(StepBlockSchema).max(40);

const StepCreateBody = z
  .object({
    kind: StepKindEnum,
    // Allow empty titles on create — the CMS pattern is to add an empty
    // step card the user types into inline. The runner renders "Untitled
    // step" when blank so the row is still scannable.
    title: z.string().max(200),
    bodyMarkdown: z.string().max(10000).nullable().optional(),
    safetyCritical: z.boolean().optional(),
    orderingHint: z.number().int().optional(),
    requiresPhoto: z.boolean().optional(),
    minPhotoCount: z.number().int().min(0).max(10).optional(),
    measurementSpec: MeasurementSpecSchema.nullable().optional(),
    blocks: BlocksArraySchema.optional(),
  })
  .refine(
    (b) =>
      b.kind !== 'measurement_required' || b.measurementSpec != null,
    { message: 'measurement_required steps must include a measurementSpec.' },
  )
  .refine(
    (b) =>
      b.kind !== 'photo_required' ||
      ((b.requiresPhoto ?? false) && (b.minPhotoCount ?? 0) >= 1),
    { message: 'photo_required steps must set requiresPhoto and minPhotoCount >= 1.' },
  );

const StepPatchBody = z
  .object({
    kind: StepKindEnum.optional(),
    title: z.string().max(200).optional(),
    bodyMarkdown: z.string().max(10000).nullable().optional(),
    safetyCritical: z.boolean().optional(),
    orderingHint: z.number().int().optional(),
    requiresPhoto: z.boolean().optional(),
    minPhotoCount: z.number().int().min(0).max(10).optional(),
    measurementSpec: MeasurementSpecSchema.nullable().optional(),
    blocks: BlocksArraySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const ReorderBody = z.object({
  orderedIds: z.array(UuidSchema).min(1),
});

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type StepRow = typeof schema.procedureSteps.$inferSelect;

function rowToDTO(row: StepRow, opts?: { audioPublicUrl?: string | null }) {
  return {
    id: row.id,
    documentId: row.documentId,
    kind: row.kind,
    title: row.title,
    bodyMarkdown: row.bodyMarkdown,
    safetyCritical: row.safetyCritical,
    orderingHint: row.orderingHint,
    requiresPhoto: row.requiresPhoto,
    minPhotoCount: row.minPhotoCount,
    measurementSpec: row.measurementSpec,
    blocks: row.blocks ?? [],
    audioStorageKey: row.audioStorageKey,
    audioContentType: row.audioContentType,
    audioSizeBytes: row.audioSizeBytes,
    audioDurationMs: row.audioDurationMs,
    audioSource: row.audioSource,
    audioUrl: opts?.audioPublicUrl ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers — load + scope
// ---------------------------------------------------------------------------

async function loadDocumentForWrite(
  db: Database,
  documentId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
} | null> {
  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, documentId),
    with: { packVersion: { with: { pack: true } } },
  });
  if (!doc) return null;
  requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
  return {
    doc,
    ownerOrganizationId: doc.packVersion.pack.ownerOrganizationId,
  };
}

async function loadStepForWrite(
  db: Database,
  stepId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  step: StepRow;
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
} | null> {
  const step = await db.query.procedureSteps.findFirst({
    where: eq(schema.procedureSteps.id, stepId),
  });
  if (!step) return null;
  const ctx = await loadDocumentForWrite(db, step.documentId, scope);
  if (!ctx) return null;
  return { step, ...ctx };
}

/**
 * Coerce evidence-required flags into a coherent state. The CHECK
 * constraints on the table reject incoherent rows, but this helper
 * lets the route surface a clearer 400 message before the DB rejects.
 */
function coerceEvidence(input: {
  kind: StepRow['kind'];
  requiresPhoto: boolean | undefined;
  minPhotoCount: number | undefined;
  measurementSpec: StepRow['measurementSpec'] | undefined;
}): {
  requiresPhoto: boolean;
  minPhotoCount: number;
  measurementSpec: StepRow['measurementSpec'];
} {
  if (input.kind === 'photo_required') {
    return {
      requiresPhoto: true,
      minPhotoCount: Math.max(1, input.minPhotoCount ?? 1),
      measurementSpec: null,
    };
  }
  if (input.kind === 'measurement_required') {
    return {
      requiresPhoto: input.requiresPhoto ?? false,
      minPhotoCount: input.minPhotoCount ?? 0,
      measurementSpec: input.measurementSpec ?? null,
    };
  }
  // instruction / safety_check
  return {
    requiresPhoto: input.requiresPhoto ?? false,
    minPhotoCount: input.minPhotoCount ?? 0,
    measurementSpec: null,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminProcedureSteps(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId/procedure-steps
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/procedure-steps',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const rows = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, request.params.documentId),
        orderBy: [
          asc(schema.procedureSteps.orderingHint),
          asc(schema.procedureSteps.createdAt),
        ],
      });
      return rows.map((r) =>
        rowToDTO(r, {
          audioPublicUrl: r.audioStorageKey
            ? storage.publicUrl(r.audioStorageKey)
            : null,
        }),
      );
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/procedure-steps — create
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: z.infer<typeof StepCreateBody>;
  }>(
    '/admin/documents/:documentId/procedure-steps',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: StepCreateBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();
      if (ctx.doc.kind !== 'structured_procedure') {
        return reply.badRequest(
          'Steps can only be authored on structured_procedure documents.',
        );
      }
      const body = request.body;
      const evidence = coerceEvidence({
        kind: body.kind,
        requiresPhoto: body.requiresPhoto,
        minPhotoCount: body.minPhotoCount,
        measurementSpec: body.measurementSpec ?? null,
      });

      // Default orderingHint: append at the end with a 100-stride gap so
      // future drag-reorders don't have to rewrite every row.
      let orderingHint = body.orderingHint;
      if (orderingHint === undefined) {
        const existing = await db.query.procedureSteps.findMany({
          where: eq(schema.procedureSteps.documentId, ctx.doc.id),
          columns: { orderingHint: true },
        });
        const max = existing.reduce(
          (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
          0,
        );
        orderingHint = max + 100;
      }

      const [row] = await db
        .insert(schema.procedureSteps)
        .values({
          documentId: ctx.doc.id,
          kind: body.kind,
          title: body.title,
          bodyMarkdown: body.bodyMarkdown ?? null,
          safetyCritical: body.safetyCritical ?? body.kind === 'safety_check',
          orderingHint,
          requiresPhoto: evidence.requiresPhoto,
          minPhotoCount: evidence.minPhotoCount,
          measurementSpec: evidence.measurementSpec ?? null,
          blocks: body.blocks ?? [],
          createdByUserId: auth.userId,
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create step.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.created',
        targetType: 'procedure_step',
        targetId: row.id,
        payload: {
          documentId: row.documentId,
          kind: row.kind,
          title: row.title,
          safetyCritical: row.safetyCritical,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return rowToDTO(row);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-steps/:stepId
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { stepId: string };
    Body: z.infer<typeof StepPatchBody>;
  }>(
    '/admin/procedure-steps/:stepId',
    {
      schema: {
        params: z.object({ stepId: UuidSchema }),
        body: StepPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();
      const b = request.body;

      // Compute the post-patch evidence shape so we can validate kind
      // coherence before hitting the DB CHECK.
      const nextKind = b.kind ?? ctx.step.kind;
      const evidence = coerceEvidence({
        kind: nextKind,
        requiresPhoto:
          b.requiresPhoto !== undefined ? b.requiresPhoto : ctx.step.requiresPhoto,
        minPhotoCount:
          b.minPhotoCount !== undefined ? b.minPhotoCount : ctx.step.minPhotoCount,
        measurementSpec:
          b.measurementSpec !== undefined ? b.measurementSpec : ctx.step.measurementSpec,
      });

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.kind !== undefined) patch.kind = nextKind;
      if (b.title !== undefined) patch.title = b.title;
      if (b.bodyMarkdown !== undefined) patch.bodyMarkdown = b.bodyMarkdown;
      if (b.safetyCritical !== undefined) patch.safetyCritical = b.safetyCritical;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.blocks !== undefined) patch.blocks = b.blocks;
      // Always write the coerced evidence trio if any of them changed,
      // so coherence is preserved.
      if (
        b.requiresPhoto !== undefined ||
        b.minPhotoCount !== undefined ||
        b.measurementSpec !== undefined ||
        b.kind !== undefined
      ) {
        patch.requiresPhoto = evidence.requiresPhoto;
        patch.minPhotoCount = evidence.minPhotoCount;
        patch.measurementSpec = evidence.measurementSpec;
      }

      const [updated] = await db
        .update(schema.procedureSteps)
        .set(patch)
        .where(eq(schema.procedureSteps.id, ctx.step.id))
        .returning();
      if (!updated) return reply.internalServerError('Update failed.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.updated',
        targetType: 'procedure_step',
        targetId: updated.id,
        payload: { fields: Object.keys(b) },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return rowToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/procedure-steps/:stepId
  //
  // Returns 409 if any procedure_step_completions reference this step —
  // we don't want to silently drop run evidence. The author should
  // first archive or rewrite the procedure (v2 surface).
  // -------------------------------------------------------------------------
  app.delete<{ Params: { stepId: string } }>(
    '/admin/procedure-steps/:stepId',
    { schema: { params: z.object({ stepId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();

      const completionCount = await db.query.procedureStepCompletions.findFirst({
        where: eq(schema.procedureStepCompletions.stepId, ctx.step.id),
        columns: { id: true },
      });
      if (completionCount) {
        return reply
          .code(409)
          .send({
            statusCode: 409,
            error: 'Conflict',
            message:
              'Step has historical run evidence and cannot be deleted. Edit it instead, or rebuild the procedure under a new version.',
          });
      }

      await db
        .delete(schema.procedureSteps)
        .where(eq(schema.procedureSteps.id, ctx.step.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.deleted',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: {
          documentId: ctx.step.documentId,
          title: ctx.step.title,
          kind: ctx.step.kind,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/procedure-steps/:stepId/parts — list linked parts
  // -------------------------------------------------------------------------
  app.get<{ Params: { stepId: string } }>(
    '/admin/procedure-steps/:stepId/parts',
    { schema: { params: z.object({ stepId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();

      const links = await db.query.partProcedureSteps.findMany({
        where: eq(schema.partProcedureSteps.procedureStepId, ctx.step.id),
      });
      if (links.length === 0) return [];
      const partIds = [...new Set(links.map((l) => l.partId))];
      const parts = await db.query.parts.findMany({
        where: inArray(schema.parts.id, partIds),
      });
      const byId = new Map(parts.map((p) => [p.id, p]));
      return links
        .map((l) => {
          const p = byId.get(l.partId);
          if (!p) return null;
          return {
            linkId: l.id,
            partId: p.id,
            oemPartNumber: p.oemPartNumber,
            displayName: p.displayName,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /admin/procedure-steps/:stepId/parts — set-replace
  // -------------------------------------------------------------------------
  app.put<{
    Params: { stepId: string };
    Body: { partIds: string[] };
  }>(
    '/admin/procedure-steps/:stepId/parts',
    {
      schema: {
        params: z.object({ stepId: UuidSchema }),
        body: z.object({ partIds: z.array(UuidSchema) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();
      const wanted = new Set(request.body.partIds);

      if (wanted.size > 0) {
        const parts = await db.query.parts.findMany({
          where: inArray(schema.parts.id, [...wanted]),
        });
        if (parts.length !== wanted.size) {
          return reply.notFound('One or more parts not found.');
        }
        for (const p of parts) requireOrgInScope(scope, p.ownerOrganizationId);
      }

      let added = 0;
      let removed = 0;
      const existing = await db.query.partProcedureSteps.findMany({
        where: eq(schema.partProcedureSteps.procedureStepId, ctx.step.id),
      });
      const existingIds = new Set(existing.map((e) => e.partId));
      const toDelete = existing.filter((e) => !wanted.has(e.partId));
      const toInsert = [...wanted].filter((pid) => !existingIds.has(pid));
      removed = toDelete.length;
      added = toInsert.length;

      if (toDelete.length > 0) {
        await db
          .delete(schema.partProcedureSteps)
          .where(
            inArray(
              schema.partProcedureSteps.id,
              toDelete.map((d) => d.id),
            ),
          );
      }
      if (toInsert.length > 0) {
        await db.insert(schema.partProcedureSteps).values(
          toInsert.map((partId) => ({
            partId,
            procedureStepId: ctx.step.id,
            createdByUserId: auth.userId,
          })),
        );
      }

      if (added > 0 || removed > 0) {
        await db.insert(schema.auditEvents).values({
          organizationId: ctx.ownerOrganizationId,
          actorUserId: auth.userId,
          eventType: 'procedure_step.parts.set',
          targetType: 'procedure_step',
          targetId: ctx.step.id,
          payload: {
            documentId: ctx.step.documentId,
            partCount: wanted.size,
            added,
            removed,
          },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      }

      return { ok: true, count: wanted.size, added, removed };
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/procedure-steps/reorder
  //
  // Single-shot rewrite of orderingHint values at intervals of 100. Lets
  // a single drag-reorder land in one round-trip.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: z.infer<typeof ReorderBody>;
  }>(
    '/admin/documents/:documentId/procedure-steps/reorder',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: ReorderBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      // Verify all IDs belong to this document. Reject if any are foreign;
      // a payload that mixes docs would silently move steps across docs.
      const steps = await db.query.procedureSteps.findMany({
        where: and(
          eq(schema.procedureSteps.documentId, ctx.doc.id),
          inArray(schema.procedureSteps.id, request.body.orderedIds),
        ),
        columns: { id: true },
      });
      if (steps.length !== request.body.orderedIds.length) {
        return reply.badRequest(
          'orderedIds contains IDs not on this document, or duplicates.',
        );
      }

      // Re-stamp ordering hints. 100-stride leaves headroom for future
      // single-step inserts without a full rewrite.
      let i = 0;
      for (const id of request.body.orderedIds) {
        i += 1;
        await db
          .update(schema.procedureSteps)
          .set({ orderingHint: i * 100, updatedAt: new Date() })
          .where(eq(schema.procedureSteps.id, id));
      }

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.reordered',
        targetType: 'document',
        targetId: ctx.doc.id,
        payload: { count: request.body.orderedIds.length },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true, count: request.body.orderedIds.length };
    },
  );
}
