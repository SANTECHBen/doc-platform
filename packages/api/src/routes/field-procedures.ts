// Field-authored procedures (procedure mode v2). PWA-facing endpoints
// for capture-as-you-go authoring on site.
//
// Surface:
//   POST /asset-instances/:id/field-procedures
//   POST /procedure-runs/:id/authoring-steps
//   POST /procedure-runs/:id/authoring-finalize
//
// Auth: every endpoint requires an authenticated user. Reading docs
// stays scan-only; writing a procedure (the unit of evidence and
// attribution) requires identity.
//
// All three endpoints share an "authoring guard": the run must be
// in_progress, owned by the caller, AND its document must live in a
// field-captures pack and not yet be promoted (fieldVerifiedAt IS NULL).
// Once promoted, the doc is treated as a normal procedure — admin can
// edit via the Steps tab; PWA-side authoring is closed.

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';
import { ensureFieldCapturesVersion } from '../lib/field-captures-pack';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const StartFieldProcedureBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

const StepKindEnum = z.enum([
  'instruction',
  'safety_check',
  'photo_required',
  'measurement_required',
]);

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

const AuthoringStepBody = z.object({
  kind: StepKindEnum,
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(10000).nullable().optional(),
  safetyCritical: z.boolean().optional(),
  requiresPhoto: z.boolean().optional(),
  minPhotoCount: z.number().int().min(0).max(10).optional(),
  measurementSpec: MeasurementSpecSchema.nullable().optional(),
  // Doc-authoring v3 — media (photos/videos) + substeps may be supplied
  // at create time, so a single save persists the whole step structure.
  media: z.array(z.object({
    kind: z.enum(['image', 'video']),
    storageKey: z.string().max(400),
    mime: z.string().max(120),
    caption: z.string().max(200).optional(),
  })).max(20).optional(),
  substeps: z.array(z.object({
    title: z.string().min(1).max(200),
    bodyMarkdown: z.string().max(5000).nullable().optional(),
  })).max(50).optional(),
});

const AuthoringFinalizeBody = z.object({
  title: z.string().min(1).max(200),
  scopeAssetInstanceOnly: z.boolean(),
  linkedPartIds: z.array(UuidSchema).max(20).default([]),
});

// Step media — author-attached photos and videos (vs run-time evidence).
// Set-replace: every PATCH that includes this field replaces the full list
// for the step. The client buffers any new uploads via the media-upload
// endpoint, then sends the resulting set with the next step PATCH.
const StepMediaItem = z.object({
  kind: z.enum(['image', 'video']),
  storageKey: z.string().max(400),
  mime: z.string().max(120),
  caption: z.string().max(200).optional(),
});

// Substep — author-defined nested step inside a parent step. Lightweight
// (title + optional body) for v1; per-substep evidence and media land in v2.
const SubstepItem = z.object({
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(5000).nullable().optional(),
});

// Same shape as AuthoringStepBody but every field optional — used by the
// in-place edit affordance on previously-saved steps in the runner.
// Also accepts media (set-replace authored photos/videos) and substeps
// (set-replace, with the server regenerating row IDs each save).
const AuthoringStepPatchBody = z
  .object({
    kind: StepKindEnum.optional(),
    title: z.string().min(1).max(200).optional(),
    bodyMarkdown: z.string().max(10000).nullable().optional(),
    safetyCritical: z.boolean().optional(),
    requiresPhoto: z.boolean().optional(),
    minPhotoCount: z.number().int().min(0).max(10).optional(),
    measurementSpec: MeasurementSpecSchema.nullable().optional(),
    media: z.array(StepMediaItem).max(20).optional(),
    substeps: z.array(SubstepItem).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const AuthoringReorderBody = z.object({
  orderedIds: z.array(UuidSchema).min(1),
});

// Procedure-doc template metadata. Always-on Title/Tools/Steps; toggled
// Safety + Verification per author preference.
const ProcedureMetadataBody = z.object({
  toolsRequired: z.array(z.string().min(1).max(200)).max(50),
  safety: z.object({
    enabled: z.boolean(),
    notes: z.string().max(5000).nullable(),
  }),
  verification: z.object({
    enabled: z.boolean(),
    notes: z.string().max(5000).nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthoringRunCtx {
  run: typeof schema.procedureRuns.$inferSelect;
  document: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
}

/**
 * Load a run + verify the caller owns it AND the run's document is
 * still in field-authoring state (field-captures pack, not yet
 * promoted). Returns null on any miss; route turns null into 404 to
 * avoid leaking existence.
 */
async function loadAuthoringRun(
  db: Database,
  runId: string,
  auth: { userId: string; platformAdmin?: boolean },
): Promise<AuthoringRunCtx | null> {
  const run = await db.query.procedureRuns.findFirst({
    where: eq(schema.procedureRuns.id, runId),
    with: {
      document: { with: { packVersion: { with: { pack: true } } } },
    },
  });
  if (!run) return null;
  if (!auth.platformAdmin && run.userId !== auth.userId) return null;
  if (!run.document) return null;
  // Authoring guard — only field-captures, only unverified, only in_progress.
  if (run.document.packVersion.pack.kind !== 'field_captures') return null;
  if (run.document.fieldVerifiedAt !== null) return null;
  if (run.status !== 'in_progress') return null;
  return {
    run,
    document: run.document,
    ownerOrganizationId: run.document.packVersion.pack.ownerOrganizationId,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerFieldProcedureRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /asset-instances/:id/field-procedures — start a field-authoring run.
  //
  // Lazy-creates the field-captures pack + version for the asset's model
  // if needed, then creates a draft document + initial procedure run.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof StartFieldProcedureBody>;
  }>(
    '/asset-instances/:id/field-procedures',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: StartFieldProcedureBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.id),
        with: {
          model: { with: { owner: true } },
          site: { with: { organization: true } },
        },
      });
      if (!instance) return reply.notFound();
      // Org scope check via the standard descendant-tree helper. This
      // matches the work-orders + sections pattern: an OEM-staff user at
      // a parent org can author against assets installed at descendant
      // customer orgs. 404 (not 403) on miss to avoid leaking existence.
      if (
        !scope.all &&
        !scope.orgIds.includes(instance.site.organization.id)
      ) {
        return reply.notFound();
      }

      const { versionId } = await ensureFieldCapturesVersion(db, {
        assetModelId: instance.assetModelId,
        ownerOrganizationId: instance.model.ownerOrganizationId,
      });

      const title = request.body.title?.trim() || 'Untitled procedure';
      const [doc] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: versionId,
          kind: 'structured_procedure',
          title,
          language: 'en',
          // Field-authored procedures default to model-wide; the tech can
          // flip "this unit only" at finalize-time to set scopeAssetInstanceId.
          scopeAssetInstanceId: null,
        })
        .returning();
      if (!doc) return reply.internalServerError();

      const [run] = await db
        .insert(schema.procedureRuns)
        .values({
          documentId: doc.id,
          userId: auth.userId,
          assetInstanceId: instance.id,
          status: 'in_progress',
        })
        .returning();
      if (!run) return reply.internalServerError();

      await db.insert(schema.auditEvents).values({
        organizationId: instance.site.organization.id,
        actorUserId: auth.userId,
        eventType: 'procedure_run.field_authoring_started',
        targetType: 'procedure_run',
        targetId: run.id,
        payload: {
          documentId: doc.id,
          assetInstanceId: instance.id,
          assetModelId: instance.assetModelId,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        run: {
          id: run.id,
          documentId: run.documentId,
          userId: run.userId,
          assetInstanceId: run.assetInstanceId,
          workOrderId: run.workOrderId,
          status: run.status,
          abandonedReason: run.abandonedReason,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt ? run.completedAt.toISOString() : null,
          lastActivityAt: run.lastActivityAt.toISOString(),
          totalActiveMs: run.totalActiveMs,
          pausedAt: run.pausedAt ? run.pausedAt.toISOString() : null,
        },
        document: {
          id: doc.id,
          title: doc.title,
          kind: doc.kind,
          safetyCritical: doc.safetyCritical,
        },
        steps: [],
        completions: [],
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/authoring-steps — append a step to the
  // in-progress field-authoring run. Returns the created step DTO.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof AuthoringStepBody>;
  }>(
    '/procedure-runs/:id/authoring-steps',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: AuthoringStepBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      const body = request.body;

      // Coerce evidence flags into a coherent state — same logic as the
      // admin step CRUD. The DB CHECK constraint will reject otherwise,
      // but a clear 400 is friendlier.
      let requiresPhoto = body.requiresPhoto ?? false;
      let minPhotoCount = body.minPhotoCount ?? 0;
      let measurementSpec = body.measurementSpec ?? null;
      if (body.kind === 'photo_required') {
        requiresPhoto = true;
        if (minPhotoCount < 1) minPhotoCount = 1;
        measurementSpec = null;
      } else if (body.kind === 'measurement_required') {
        if (!measurementSpec) {
          return reply.badRequest(
            'measurement_required steps must include a measurementSpec.',
          );
        }
      } else {
        // instruction | safety_check
        measurementSpec = null;
      }

      // Append at the end with a 100-stride gap.
      const existing = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, ctx.document.id),
        columns: { orderingHint: true },
      });
      const maxOrder = existing.reduce(
        (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
        0,
      );

      const [step] = await db
        .insert(schema.procedureSteps)
        .values({
          documentId: ctx.document.id,
          kind: body.kind,
          title: body.title,
          bodyMarkdown: body.bodyMarkdown ?? null,
          safetyCritical:
            body.safetyCritical ?? body.kind === 'safety_check',
          orderingHint: maxOrder + 100,
          requiresPhoto,
          minPhotoCount,
          measurementSpec: measurementSpec ?? null,
          media: body.media ?? [],
          createdByUserId: auth.userId,
        })
        .returning();
      if (!step) return reply.internalServerError();

      // Substeps inserted in a second statement so we can return them
      // in the response (mirrors the PATCH set-replace flow).
      let savedSubsteps: typeof schema.procedureSubsteps.$inferSelect[] = [];
      if (body.substeps && body.substeps.length > 0) {
        savedSubsteps = await db
          .insert(schema.procedureSubsteps)
          .values(
            body.substeps.map((s, i) => ({
              procedureStepId: step.id,
              title: s.title,
              bodyMarkdown: s.bodyMarkdown ?? null,
              orderingHint: (i + 1) * 100,
              createdByUserId: auth.userId,
            })),
          )
          .returning();
      }

      // Update run.lastActivityAt so an idle sweeper later doesn't garbage-
      // collect a still-in-progress field-authoring run.
      await db
        .update(schema.procedureRuns)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.procedureRuns.id, ctx.run.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.field_authored',
        targetType: 'procedure_step',
        targetId: step.id,
        payload: {
          runId: ctx.run.id,
          documentId: ctx.document.id,
          kind: step.kind,
          title: step.title,
          safetyCritical: step.safetyCritical,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        id: step.id,
        documentId: step.documentId,
        kind: step.kind,
        title: step.title,
        bodyMarkdown: step.bodyMarkdown,
        safetyCritical: step.safetyCritical,
        orderingHint: step.orderingHint,
        requiresPhoto: step.requiresPhoto,
        minPhotoCount: step.minPhotoCount,
        measurementSpec: step.measurementSpec,
        media: step.media,
        substeps: savedSubsteps.map((s) => ({
          id: s.id,
          title: s.title,
          bodyMarkdown: s.bodyMarkdown,
          orderingHint: s.orderingHint,
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/authoring-finalize — set title, scope, and
  // part links. Caller usually follows up with POST /procedure-runs/:id/
  // finish to transition the run to completed (the finish endpoint runs
  // the per-step evidence gate).
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof AuthoringFinalizeBody>;
  }>(
    '/procedure-runs/:id/authoring-finalize',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: AuthoringFinalizeBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      const body = request.body;

      const scopeAssetInstanceId = body.scopeAssetInstanceOnly
        ? ctx.run.assetInstanceId ?? null
        : null;

      // Validate parts: must exist and be visible in the caller's org tree.
      if (body.linkedPartIds.length > 0) {
        const parts = await db.query.parts.findMany({
          where: inArray(schema.parts.id, body.linkedPartIds),
        });
        if (parts.length !== body.linkedPartIds.length) {
          return reply.notFound('One or more parts not found.');
        }
        for (const p of parts) {
          requireOrgInScope(scope, p.ownerOrganizationId);
        }
      }

      const [updated] = await db
        .update(schema.documents)
        .set({
          title: body.title,
          scopeAssetInstanceId,
        })
        .where(eq(schema.documents.id, ctx.document.id))
        .returning();
      if (!updated) return reply.internalServerError();

      // Link every captured step to all selected parts (v1 simplification —
      // per-step granular linking is v2). Set-replace pattern: clear any
      // existing links for this doc's steps and re-write.
      if (body.linkedPartIds.length > 0) {
        const stepIds = (
          await db.query.procedureSteps.findMany({
            where: eq(schema.procedureSteps.documentId, ctx.document.id),
            columns: { id: true },
          })
        ).map((s) => s.id);
        if (stepIds.length > 0) {
          await db.transaction(async (tx) => {
            await tx
              .delete(schema.partProcedureSteps)
              .where(inArray(schema.partProcedureSteps.procedureStepId, stepIds));
            const rows = stepIds.flatMap((stepId) =>
              body.linkedPartIds.map((partId) => ({
                partId,
                procedureStepId: stepId,
                createdByUserId: auth.userId,
              })),
            );
            if (rows.length > 0) {
              await tx.insert(schema.partProcedureSteps).values(rows);
            }
          });
        }
      }

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.field_authoring_finalized',
        targetType: 'procedure_run',
        targetId: ctx.run.id,
        payload: {
          documentId: ctx.document.id,
          title: body.title,
          scopeAssetInstanceOnly: body.scopeAssetInstanceOnly,
          partCount: body.linkedPartIds.length,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        ok: true,
        documentId: updated.id,
        title: updated.title,
        scopeAssetInstanceId: updated.scopeAssetInstanceId,
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:id/verify — promote a field-captured doc to
  // verified. Removes the UNVERIFIED chip in the PWA.
  //
  // Auth: any user in the doc's owner org can promote. (Tightening to
  // a specific role is a follow-up once we have a role picker.)
  // Idempotent: re-verify is a no-op.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/documents/:id/verify',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      if (
        !scope.all &&
        !scope.orgIds.includes(doc.packVersion.pack.ownerOrganizationId)
      ) {
        return reply.notFound();
      }
      if (doc.packVersion.pack.kind !== 'field_captures') {
        return reply.badRequest(
          'Verify is only meaningful on field-captured documents.',
        );
      }

      // Idempotent: if already verified, return the current state.
      if (doc.fieldVerifiedAt !== null) {
        return {
          documentId: doc.id,
          fieldVerifiedAt: doc.fieldVerifiedAt.toISOString(),
          fieldVerifiedByUserId: doc.fieldVerifiedByUserId,
        };
      }

      const now = new Date();
      const [updated] = await db
        .update(schema.documents)
        .set({
          fieldVerifiedAt: now,
          fieldVerifiedByUserId: auth.userId,
        })
        .where(eq(schema.documents.id, doc.id))
        .returning();
      if (!updated) return reply.internalServerError();

      await db.insert(schema.auditEvents).values({
        organizationId: doc.packVersion.pack.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'document.field_verified',
        targetType: 'document',
        targetId: doc.id,
        payload: { title: doc.title },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        documentId: updated.id,
        fieldVerifiedAt: now.toISOString(),
        fieldVerifiedByUserId: auth.userId,
      };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /procedure-runs/:id/authoring-steps/:stepId — edit a previously
  // saved step from the runner's captured-steps list. Same authoring guard
  // as the add endpoint (run owner + field-captures + not yet verified).
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string; stepId: string };
    Body: z.infer<typeof AuthoringStepPatchBody>;
  }>(
    '/procedure-runs/:id/authoring-steps/:stepId',
    {
      schema: {
        params: z.object({ id: UuidSchema, stepId: UuidSchema }),
        body: AuthoringStepPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      const step = await db.query.procedureSteps.findFirst({
        where: eq(schema.procedureSteps.id, request.params.stepId),
      });
      if (!step || step.documentId !== ctx.document.id) {
        return reply.notFound();
      }

      const b = request.body;
      const nextKind = b.kind ?? step.kind;

      // Coerce evidence trio against the post-patch kind (mirrors the
      // admin step CRUD's coerceEvidence logic).
      let requiresPhoto = b.requiresPhoto !== undefined ? b.requiresPhoto : step.requiresPhoto;
      let minPhotoCount = b.minPhotoCount !== undefined ? b.minPhotoCount : step.minPhotoCount;
      let measurementSpec =
        b.measurementSpec !== undefined ? b.measurementSpec : step.measurementSpec;
      if (nextKind === 'photo_required') {
        requiresPhoto = true;
        if (minPhotoCount < 1) minPhotoCount = 1;
        measurementSpec = null;
      } else if (nextKind === 'measurement_required') {
        if (!measurementSpec) {
          return reply.badRequest(
            'measurement_required steps must include a measurementSpec.',
          );
        }
      } else {
        measurementSpec = null;
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.kind !== undefined) patch.kind = nextKind;
      if (b.title !== undefined) patch.title = b.title;
      if (b.bodyMarkdown !== undefined) patch.bodyMarkdown = b.bodyMarkdown;
      if (b.safetyCritical !== undefined) patch.safetyCritical = b.safetyCritical;
      if (b.media !== undefined) patch.media = b.media;
      if (
        b.kind !== undefined ||
        b.requiresPhoto !== undefined ||
        b.minPhotoCount !== undefined ||
        b.measurementSpec !== undefined
      ) {
        patch.requiresPhoto = requiresPhoto;
        patch.minPhotoCount = minPhotoCount;
        patch.measurementSpec = measurementSpec ?? null;
      }

      const [updated] = await db
        .update(schema.procedureSteps)
        .set(patch)
        .where(eq(schema.procedureSteps.id, step.id))
        .returning();
      if (!updated) return reply.internalServerError();

      // Substeps — set-replace pattern. Server regenerates row IDs each
      // time; v2 can move to stable IDs if per-substep evidence becomes
      // a thing.
      let savedSubsteps: typeof schema.procedureSubsteps.$inferSelect[] = [];
      if (b.substeps !== undefined) {
        await db
          .delete(schema.procedureSubsteps)
          .where(eq(schema.procedureSubsteps.procedureStepId, step.id));
        if (b.substeps.length > 0) {
          savedSubsteps = await db
            .insert(schema.procedureSubsteps)
            .values(
              b.substeps.map((s, i) => ({
                procedureStepId: step.id,
                title: s.title,
                bodyMarkdown: s.bodyMarkdown ?? null,
                orderingHint: (i + 1) * 100,
                createdByUserId: auth.userId,
              })),
            )
            .returning();
        }
      } else {
        savedSubsteps = await db.query.procedureSubsteps.findMany({
          where: eq(schema.procedureSubsteps.procedureStepId, step.id),
          orderBy: [
            asc(schema.procedureSubsteps.orderingHint),
            asc(schema.procedureSubsteps.createdAt),
          ],
        });
      }

      await db
        .update(schema.procedureRuns)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.procedureRuns.id, ctx.run.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.field_authored.edited',
        targetType: 'procedure_step',
        targetId: updated.id,
        payload: { runId: ctx.run.id, fields: Object.keys(b) },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        id: updated.id,
        documentId: updated.documentId,
        kind: updated.kind,
        title: updated.title,
        bodyMarkdown: updated.bodyMarkdown,
        safetyCritical: updated.safetyCritical,
        orderingHint: updated.orderingHint,
        requiresPhoto: updated.requiresPhoto,
        minPhotoCount: updated.minPhotoCount,
        measurementSpec: updated.measurementSpec,
        media: updated.media,
        substeps: savedSubsteps.map((s) => ({
          id: s.id,
          title: s.title,
          bodyMarkdown: s.bodyMarkdown,
          orderingHint: s.orderingHint,
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/authoring-steps/reorder — re-stamp ordering
  // hints in a single round-trip so the captured-steps list can be drag-
  // or button-reordered before Finish.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof AuthoringReorderBody>;
  }>(
    '/procedure-runs/:id/authoring-steps/reorder',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: AuthoringReorderBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      // Verify all IDs belong to this run's document; reject foreign IDs.
      const steps = await db.query.procedureSteps.findMany({
        where: and(
          eq(schema.procedureSteps.documentId, ctx.document.id),
          inArray(schema.procedureSteps.id, request.body.orderedIds),
        ),
        columns: { id: true },
      });
      if (steps.length !== request.body.orderedIds.length) {
        return reply.badRequest(
          'orderedIds contains IDs not on this run, or duplicates.',
        );
      }

      // Re-stamp at 100-stride. Same convention as admin reorder so the
      // post-Finish admin Steps tab keeps the order the tech captured in.
      let i = 0;
      for (const id of request.body.orderedIds) {
        i += 1;
        await db
          .update(schema.procedureSteps)
          .set({ orderingHint: i * 100, updatedAt: new Date() })
          .where(eq(schema.procedureSteps.id, id));
      }

      await db
        .update(schema.procedureRuns)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.procedureRuns.id, ctx.run.id));

      return { ok: true, count: request.body.orderedIds.length };
    },
  );

  // -------------------------------------------------------------------------
  // GET /asset-instances/:id/procedure-templates — recent procedures on
  // this asset's MODEL that the tech can use as a starting structure
  // for a new field capture. Returns title + step count + author.
  //
  // Visibility: any model-wide procedure (OEM-authored or field-verified)
  // on this asset model. Instance-only field captures are excluded — they
  // belong to a different asset.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/asset-instances/:id/procedure-templates',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.id),
        with: { site: { with: { organization: true } } },
      });
      if (!instance) return reply.notFound();
      if (
        !scope.all &&
        !scope.orgIds.includes(instance.site.organization.id)
      ) {
        return reply.notFound();
      }

      // Find every structured_procedure doc that lives in a content-pack
      // version owned by an asset model belonging to instance.assetModelId,
      // and that's either: in an OEM/authored pack OR a field-captures
      // pack with at least one verification (or any field doc — we surface
      // unverified too so techs can clone evolving procedures). For v1 we
      // surface ALL structured_procedure docs on this asset model that
      // have steps and aren't instance-scoped to a different instance.
      const rows = await db.execute<{
        document_id: string;
        title: string;
        step_count: number;
        captured_by_display_name: string | null;
        source: 'oem' | 'field';
        verified: boolean;
        finished_at: string | null;
      }>(sql`
        SELECT
          d.id AS document_id,
          d.title AS title,
          (SELECT COUNT(*)::int FROM procedure_steps ps WHERE ps.document_id = d.id) AS step_count,
          u.display_name AS captured_by_display_name,
          CASE WHEN cp.kind = 'field_captures' THEN 'field' ELSE 'oem' END AS source,
          (d.field_verified_at IS NOT NULL) AS verified,
          (
            SELECT MAX(pr.completed_at)::text
            FROM procedure_runs pr
            WHERE pr.document_id = d.id AND pr.status = 'completed'
          ) AS finished_at
        FROM documents d
        JOIN content_pack_versions cpv ON cpv.id = d.content_pack_version_id
        JOIN content_packs cp ON cp.id = cpv.content_pack_id
        LEFT JOIN procedure_runs pr0 ON pr0.document_id = d.id
        LEFT JOIN users u ON u.id = pr0.user_id
        WHERE cp.asset_model_id = ${instance.assetModelId}
          AND d.kind = 'structured_procedure'
          AND (d.scope_asset_instance_id IS NULL OR d.scope_asset_instance_id = ${instance.id})
          AND EXISTS (SELECT 1 FROM procedure_steps ps WHERE ps.document_id = d.id)
        GROUP BY d.id, d.title, u.display_name, cp.kind, d.field_verified_at
        ORDER BY finished_at DESC NULLS LAST, d.created_at DESC
        LIMIT 20
      `);

      return rows.map((r) => ({
        documentId: r.document_id,
        title: r.title,
        stepCount: r.step_count,
        capturedByDisplayName: r.captured_by_display_name,
        source: r.source,
        verified: r.verified,
        finishedAt: r.finished_at,
      }));
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/clone-from/:templateDocId — copy step
  // structures (titles, kinds, bodies, evidence requirements,
  // measurement specs) from an existing procedure into the in-progress
  // authoring run's document. Skips completion records — the tech
  // captures fresh evidence as they walk through.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string; templateDocId: string } }>(
    '/procedure-runs/:id/clone-from/:templateDocId',
    {
      schema: {
        params: z.object({
          id: UuidSchema,
          templateDocId: UuidSchema,
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      const template = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.templateDocId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!template) return reply.notFound();
      if (
        !scope.all &&
        !scope.orgIds.includes(template.packVersion.pack.ownerOrganizationId)
      ) {
        return reply.notFound();
      }
      if (template.kind !== 'structured_procedure') {
        return reply.badRequest('Template must be a structured_procedure document.');
      }

      // Don't clone over an already-populated run — the tech can edit
      // captured steps but mid-run cloning would overwrite their work.
      const existingSteps = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, ctx.document.id),
        columns: { id: true },
      });
      if (existingSteps.length > 0) {
        return reply.conflict(
          'Run already has captured steps. Templates can only seed an empty run.',
        );
      }

      const templateSteps = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, template.id),
        orderBy: [
          asc(schema.procedureSteps.orderingHint),
          asc(schema.procedureSteps.createdAt),
        ],
      });
      if (templateSteps.length === 0) {
        return reply.badRequest('Template has no steps.');
      }

      const inserted = await db
        .insert(schema.procedureSteps)
        .values(
          templateSteps.map((s, i) => ({
            documentId: ctx.document.id,
            kind: s.kind,
            title: s.title,
            bodyMarkdown: s.bodyMarkdown,
            safetyCritical: s.safetyCritical,
            orderingHint: (i + 1) * 100,
            requiresPhoto: s.requiresPhoto,
            minPhotoCount: s.minPhotoCount,
            measurementSpec: s.measurementSpec,
            createdByUserId: auth.userId,
          })),
        )
        .returning();

      await db
        .update(schema.procedureRuns)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.procedureRuns.id, ctx.run.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.cloned_from_template',
        targetType: 'procedure_run',
        targetId: ctx.run.id,
        payload: {
          templateDocumentId: template.id,
          templateTitle: template.title,
          stepCount: inserted.length,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        ok: true,
        stepCount: inserted.length,
        steps: inserted.map((s) => ({
          id: s.id,
          documentId: s.documentId,
          kind: s.kind,
          title: s.title,
          bodyMarkdown: s.bodyMarkdown,
          safetyCritical: s.safetyCritical,
          orderingHint: s.orderingHint,
          requiresPhoto: s.requiresPhoto,
          minPhotoCount: s.minPhotoCount,
          measurementSpec: s.measurementSpec,
          media: s.media,
          substeps: [] as Array<{ id: string; title: string; bodyMarkdown: string | null; orderingHint: number }>,
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/authoring-steps/:stepId/media — multipart
  // upload for authored step media (photos OR videos). Distinct from the
  // evidence /photo endpoint, which captures run-time evidence. Returns
  // the storage key + mime; the client then PATCHes the step's media
  // array with the new entry.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string; stepId: string } }>(
    '/procedure-runs/:id/authoring-steps/:stepId/media',
    { schema: { params: z.object({ id: UuidSchema, stepId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      const step = await db.query.procedureSteps.findFirst({
        where: eq(schema.procedureSteps.id, request.params.stepId),
      });
      if (!step || step.documentId !== ctx.document.id) return reply.notFound();

      const file = await request.file();
      if (!file) return reply.badRequest('Multipart file is required.');

      const mime = file.mimetype ?? '';
      const isImage = mime.startsWith('image/');
      const isVideo = mime.startsWith('video/');
      if (!isImage && !isVideo) {
        return reply.badRequest('Only image/* or video/* uploads are accepted.');
      }

      const buffer = await file.toBuffer();
      const result = await storage.putBuffer({
        buffer,
        filename: file.filename ?? (isVideo ? 'video.mp4' : 'photo.jpg'),
        contentType: mime,
      });

      return {
        kind: isVideo ? ('video' as const) : ('image' as const),
        storageKey: result.storageKey,
        mime,
        size: result.size,
        url: storage.publicUrl(result.storageKey),
      };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /procedure-runs/:id/authoring-metadata — set the procedure-doc
  // template metadata (tools required, safety toggle/notes, verification
  // toggle/notes). Stored on the document row as jsonb.
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: z.infer<typeof ProcedureMetadataBody>;
  }>(
    '/procedure-runs/:id/authoring-metadata',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: ProcedureMetadataBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      const [updated] = await db
        .update(schema.documents)
        .set({ procedureMetadata: request.body })
        .where(eq(schema.documents.id, ctx.document.id))
        .returning();
      if (!updated) return reply.internalServerError();

      await db
        .update(schema.procedureRuns)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.procedureRuns.id, ctx.run.id));

      return {
        documentId: updated.id,
        procedureMetadata: updated.procedureMetadata,
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/complete-authoring — transition the run to
  // 'completed' WITHOUT the per-step evidence gate that finishProcedureRun
  // enforces. Doc-authoring procedures are reference content; the author
  // isn't "running" them, so step completions aren't required.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/procedure-runs/:id/complete-authoring',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadAuthoringRun(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      // Verify the doc has at least one step before marking complete —
      // an empty procedure isn't useful as a reference.
      const stepCount = await db.query.procedureSteps.findFirst({
        where: eq(schema.procedureSteps.documentId, ctx.document.id),
        columns: { id: true },
      });
      if (!stepCount) {
        return reply
          .code(409)
          .send({
            statusCode: 409,
            error: 'Conflict',
            message: 'Procedure must have at least one step to complete.',
          });
      }

      const now = new Date();
      const [updated] = await db
        .update(schema.procedureRuns)
        .set({
          status: 'completed',
          completedAt: now,
          lastActivityAt: now,
        })
        .where(eq(schema.procedureRuns.id, ctx.run.id))
        .returning();
      if (!updated) return reply.internalServerError();

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.authoring_completed',
        targetType: 'procedure_run',
        targetId: ctx.run.id,
        payload: { documentId: ctx.document.id },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return {
        runId: updated.id,
        documentId: ctx.document.id,
        status: updated.status,
        completedAt: updated.completedAt?.toISOString() ?? null,
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /procedure-docs/:docId — full procedure-doc tree for the viewer
  // and for resuming an in-progress authoring session. Returns metadata,
  // steps, substeps, and media in one shot.
  //
  // Auth: requireAuthOrScan-equivalent — same access as the standard doc
  // listing. Reading procedures stays scan-friendly; only writes need
  // auth.
  // -------------------------------------------------------------------------
  app.get<{ Params: { docId: string } }>(
    '/procedure-docs/:docId',
    { schema: { params: z.object({ docId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.docId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      if (
        !scope.all &&
        !scope.orgIds.includes(doc.packVersion.pack.ownerOrganizationId)
      ) {
        return reply.notFound();
      }
      if (doc.kind !== 'structured_procedure') {
        return reply.badRequest('Document is not a structured_procedure.');
      }

      const steps = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, doc.id),
        orderBy: [
          asc(schema.procedureSteps.orderingHint),
          asc(schema.procedureSteps.createdAt),
        ],
      });
      const stepIds = steps.map((s) => s.id);
      const substeps = stepIds.length
        ? await db.query.procedureSubsteps.findMany({
            where: inArray(schema.procedureSubsteps.procedureStepId, stepIds),
            orderBy: [
              asc(schema.procedureSubsteps.orderingHint),
              asc(schema.procedureSubsteps.createdAt),
            ],
          })
        : [];
      const substepsByStep = new Map<string, typeof substeps>();
      for (const ss of substeps) {
        const arr = substepsByStep.get(ss.procedureStepId) ?? [];
        arr.push(ss);
        substepsByStep.set(ss.procedureStepId, arr);
      }

      // Capture identity for the chip.
      let capturedByDisplayName: string | null = null;
      const firstRun = await db.query.procedureRuns.findFirst({
        where: eq(schema.procedureRuns.documentId, doc.id),
        orderBy: [asc(schema.procedureRuns.startedAt)],
      });
      if (firstRun) {
        const u = await db.query.users.findFirst({
          where: eq(schema.users.id, firstRun.userId),
          columns: { displayName: true },
        });
        capturedByDisplayName = u?.displayName ?? null;
      }

      return {
        document: {
          id: doc.id,
          title: doc.title,
          kind: doc.kind,
          safetyCritical: doc.safetyCritical,
          source:
            doc.packVersion.pack.kind === 'field_captures'
              ? ('field' as const)
              : ('oem' as const),
          verified: doc.fieldVerifiedAt !== null,
          capturedByDisplayName,
          scopeAssetInstanceId: doc.scopeAssetInstanceId,
        },
        metadata: doc.procedureMetadata ?? null,
        steps: steps.map((s) => ({
          id: s.id,
          kind: s.kind,
          title: s.title,
          bodyMarkdown: s.bodyMarkdown,
          safetyCritical: s.safetyCritical,
          orderingHint: s.orderingHint,
          requiresPhoto: s.requiresPhoto,
          minPhotoCount: s.minPhotoCount,
          measurementSpec: s.measurementSpec,
          media: (s.media ?? []).map((m) => ({
            ...m,
            url: storage.publicUrl(m.storageKey),
          })),
          substeps: (substepsByStep.get(s.id) ?? []).map((ss) => ({
            id: ss.id,
            title: ss.title,
            bodyMarkdown: ss.bodyMarkdown,
            orderingHint: ss.orderingHint,
          })),
        })),
      };
    },
  );
}
