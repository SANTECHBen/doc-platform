// Procedure mode runtime routes (PWA-facing).
//
// Surface:
//   POST   /documents/:docId/procedure-runs
//   GET    /procedure-runs/:id
//   PATCH  /procedure-runs/:id/steps/:stepId
//   POST   /procedure-runs/:id/steps/:stepId/photo   (multipart)
//   POST   /procedure-runs/:id/finish
//   POST   /procedure-runs/:id/pause
//   POST   /procedure-runs/:id/resume
//   POST   /procedure-runs/:id/abandon
//
// Auth: every endpoint requires an authenticated user (OIDC). Reading
// docs/parts via QR scan stays scan-only; only writing a procedure run
// requires identity. The plan calls this out explicitly — competency
// tracking, attribution, and work-order resolution depend on knowing
// which tech ran which procedure.
//
// State machine (server-enforced; PATCH/finish/pause/resume/abandon all
// validate the current status before applying):
//
//     [POST run]
//        |
//        v
//   in_progress  <->  paused
//        |               |
//        v               v
//   completed     |  abandoned    (terminal)
//
// Step PATCHes are only accepted when status='in_progress'.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import {
  expandStep,
  loadSnippetMap,
  type SnippetBadge,
} from '../services/snippet-expansion';

// ---------------------------------------------------------------------------
// Zod request schemas
// ---------------------------------------------------------------------------

const StartRunBody = z.object({
  assetInstanceId: UuidSchema.nullable().optional(),
  workOrderId: UuidSchema.nullable().optional(),
});

// PATCH step completion. Discriminated on outcome:
//   completed  — photos + optional measurement + optional notes
//   skipped    — required reason (and notes required when step is safety-critical)
const PhotoRef = z.object({
  key: z.string().max(400),
  mime: z.string().max(120),
  caption: z.string().max(200).optional(),
});

const NumericMeasurement = z.object({
  kind: z.literal('numeric'),
  value: z.number(),
  // When the value violates the step's spec (min/max), the tech must
  // confirm an override before the row is accepted. Null = within spec.
  overrideReason: z.string().min(1).max(500).optional(),
});

const PassFailMeasurement = z.object({
  kind: z.literal('pass_fail'),
  value: z.enum(['pass', 'fail']),
});

const FreeTextMeasurement = z.object({
  kind: z.literal('free_text'),
  value: z.string().max(500),
});

const StepMeasurement = z.discriminatedUnion('kind', [
  NumericMeasurement,
  PassFailMeasurement,
  FreeTextMeasurement,
]);

const CompletedStepBody = z.object({
  outcome: z.literal('completed'),
  photos: z.array(PhotoRef).max(10).default([]),
  measurement: StepMeasurement.nullable().optional(),
  notes: z.string().max(2000).optional(),
  // Client-supplied "when did you first arrive at this step." Lets us
  // compute timeMs without a separate timer endpoint. The client should
  // subtract any pause windows it observed; v2 will reconcile against
  // the server-side run.totalActiveMs for sanity.
  enteredAt: z.string().datetime(),
});

const SkippedStepBody = z.object({
  outcome: z.literal('skipped'),
  skipReason: z.string().min(1).max(500),
  notes: z.string().max(2000).optional(),
  enteredAt: z.string().datetime(),
});

const StepPatchBody = z.discriminatedUnion('outcome', [
  CompletedStepBody,
  SkippedStepBody,
]);

const AbandonBody = z.object({
  reason: z.string().min(1).max(500),
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

type StepRow = typeof schema.procedureSteps.$inferSelect;
type RunRow = typeof schema.procedureRuns.$inferSelect;
type CompletionRow = typeof schema.procedureStepCompletions.$inferSelect;

function stepToDTO(
  s: StepRow,
  opts?: {
    expanded?: { blocks: StepRow['blocks']; title: string };
    snippetBadge?: SnippetBadge | null;
  },
) {
  return {
    id: s.id,
    documentId: s.documentId,
    sectionId: s.sectionId,
    linkedProcedureDocId: s.linkedProcedureDocId,
    linkedProcedureStepIds: s.linkedProcedureStepIds ?? [],
    kind: s.kind,
    title: opts?.expanded ? opts.expanded.title : s.title,
    bodyMarkdown: s.bodyMarkdown,
    safetyCritical: s.safetyCritical,
    orderingHint: s.orderingHint,
    requiresPhoto: s.requiresPhoto,
    minPhotoCount: s.minPhotoCount,
    measurementSpec: s.measurementSpec,
    blocks: opts?.expanded ? opts.expanded.blocks : (s.blocks ?? []),
    snippetBadge: opts?.snippetBadge ?? null,
  };
}

/**
 * Map a list of step rows through snippet expansion. Used by the PWA run
 * routes so the Job Aid renders snippet-backed steps with current content
 * + a "From snippet: …" badge.
 */
async function stepsToDTOWithExpansion(
  db: Database,
  rows: StepRow[],
): Promise<ReturnType<typeof stepToDTO>[]> {
  const snippetMap = await loadSnippetMap(db, rows.map((r) => r.snippetId));
  return rows.map((s) => {
    const expanded = expandStep(
      {
        snippetId: s.snippetId,
        snippetDetached: s.snippetDetached,
        title: s.title,
        blocks: s.blocks ?? [],
      },
      snippetMap,
    );
    return stepToDTO(s, {
      expanded: { blocks: expanded.blocks, title: expanded.title },
      snippetBadge: expanded._snippetBadge,
    });
  });
}

function sectionToDTO(s: typeof schema.procedureSections.$inferSelect) {
  return {
    id: s.id,
    documentId: s.documentId,
    title: s.title,
    description: s.description,
    orderingHint: s.orderingHint,
  };
}

function runToDTO(r: RunRow) {
  return {
    id: r.id,
    documentId: r.documentId,
    userId: r.userId,
    assetInstanceId: r.assetInstanceId,
    workOrderId: r.workOrderId,
    status: r.status,
    abandonedReason: r.abandonedReason,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    lastActivityAt: r.lastActivityAt.toISOString(),
    totalActiveMs: r.totalActiveMs,
    pausedAt: r.pausedAt ? r.pausedAt.toISOString() : null,
  };
}

function completionToDTO(c: CompletionRow) {
  return {
    id: c.id,
    runId: c.runId,
    stepId: c.stepId,
    outcome: c.outcome,
    skipReason: c.skipReason,
    photos: c.photos,
    numericValue: c.numericValue,
    passFailValue: c.passFailValue,
    textValue: c.textValue,
    measurementOutOfSpec: c.measurementOutOfSpec,
    measurementOverrideReason: c.measurementOverrideReason,
    notes: c.notes,
    enteredAt: c.enteredAt.toISOString(),
    completedAt: c.completedAt.toISOString(),
    timeMs: c.timeMs,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunCtx {
  run: RunRow;
  document: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
}

/**
 * Load a run + verify the caller owns it. Platform admins bypass the
 * ownership check via scope.all. Returns null when missing/not-allowed
 * — the route turns null into 404 to avoid leaking existence.
 *
 * Org-wide visibility (a supervisor reviewing a tech's run) is v2; v1
 * is strictly own-run-or-platform-admin.
 */
async function loadRunForOwner(
  db: Database,
  runId: string,
  auth: { userId: string; platformAdmin?: boolean },
): Promise<RunCtx | null> {
  const run = await db.query.procedureRuns.findFirst({
    where: eq(schema.procedureRuns.id, runId),
    with: {
      document: { with: { packVersion: { with: { pack: true } } } },
    },
  });
  if (!run) return null;
  if (!auth.platformAdmin && run.userId !== auth.userId) return null;
  if (!run.document) {
    // Document was deleted but run row survives. Edge case — treat as
    // not-actionable for v1 (PATCH/finish would be incoherent).
    return null;
  }
  return {
    run,
    document: run.document,
    ownerOrganizationId: run.document.packVersion.pack.ownerOrganizationId,
  };
}

/**
 * Validate a numeric measurement against a step's spec. Returns
 *   { outOfSpec: boolean, reason?: string }
 * `reason` is set when out-of-spec to surface in the error response or
 * record when an override is provided.
 */
function evaluateNumeric(
  value: number,
  spec: { min?: number | null; max?: number | null },
): { outOfSpec: boolean; reason?: string } {
  if (spec.min != null && value < spec.min) {
    return { outOfSpec: true, reason: `Below min ${spec.min}` };
  }
  if (spec.max != null && value > spec.max) {
    return { outOfSpec: true, reason: `Above max ${spec.max}` };
  }
  return { outOfSpec: false };
}

/**
 * Audit-event helper. Mirrors the documentSections / workOrders patterns:
 *  one event per state change, payload is small + queryable.
 */
async function audit(
  db: Database,
  params: {
    organizationId: string;
    actorUserId: string;
    eventType: string;
    targetId: string;
    payload: Record<string, unknown>;
    request: FastifyRequest;
  },
): Promise<void> {
  await db.insert(schema.auditEvents).values({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    eventType: params.eventType,
    targetType: 'procedure_run',
    targetId: params.targetId,
    payload: params.payload,
    ipAddress: params.request.ip,
    userAgent: params.request.headers['user-agent'] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerProcedureRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /documents/:docId/procedure-runs — start a run
  //
  // Idempotent on (userId, docId, assetInstanceId): if an active run
  // already exists, return that one (200) rather than 409. Lets a tech
  // resume from a stale tab without losing context.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { docId: string };
    Body: z.infer<typeof StartRunBody>;
  }>(
    '/documents/:docId/procedure-runs',
    {
      schema: {
        params: z.object({ docId: UuidSchema }),
        body: StartRunBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);

      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.docId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      if (doc.kind !== 'structured_procedure') {
        return reply.badRequest('Document is not a structured_procedure.');
      }

      const [steps, sections] = await Promise.all([
        db.query.procedureSteps.findMany({
          where: eq(schema.procedureSteps.documentId, doc.id),
          orderBy: [
            asc(schema.procedureSteps.orderingHint),
            asc(schema.procedureSteps.createdAt),
          ],
        }),
        db.query.procedureSections.findMany({
          where: eq(schema.procedureSections.documentId, doc.id),
          orderBy: [
            asc(schema.procedureSections.orderingHint),
            asc(schema.procedureSections.createdAt),
          ],
        }),
      ]);
      if (steps.length === 0) {
        return reply.badRequest(
          'Procedure has no authored steps. Author steps in the admin first.',
        );
      }

      const assetInstanceId = request.body.assetInstanceId ?? null;
      const workOrderId = request.body.workOrderId ?? null;

      // If an active run already exists for this (user, doc, asset), reuse it.
      // The partial unique index would 409 the insert anyway; intercepting
      // here gives the PWA a smooth resume.
      const active = await db.query.procedureRuns.findFirst({
        where: and(
          eq(schema.procedureRuns.userId, auth.userId),
          eq(schema.procedureRuns.documentId, doc.id),
          assetInstanceId === null
            ? sql`${schema.procedureRuns.assetInstanceId} IS NULL`
            : eq(schema.procedureRuns.assetInstanceId, assetInstanceId),
          inArray(schema.procedureRuns.status, ['in_progress', 'paused']),
        ),
      });

      let run: RunRow;
      if (active) {
        run = active;
      } else {
        const [created] = await db
          .insert(schema.procedureRuns)
          .values({
            documentId: doc.id,
            userId: auth.userId,
            assetInstanceId,
            workOrderId,
            status: 'in_progress',
          })
          .returning();
        if (!created) return reply.internalServerError();
        run = created;

        await audit(db, {
          organizationId: doc.packVersion.pack.ownerOrganizationId,
          actorUserId: auth.userId,
          eventType: 'procedure_run.started',
          targetId: run.id,
          payload: {
            documentId: doc.id,
            assetInstanceId,
            workOrderId,
          },
          request,
        });
      }

      const completions = await db.query.procedureStepCompletions.findMany({
        where: eq(schema.procedureStepCompletions.runId, run.id),
      });

      return {
        run: runToDTO(run),
        document: {
          id: doc.id,
          title: doc.title,
          kind: doc.kind,
          safetyCritical: doc.safetyCritical,
        },
        sections: sections.map(sectionToDTO),
        steps: await stepsToDTOWithExpansion(db, steps),
        completions: completions.map(completionToDTO),
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /procedure-runs/:id — fetch full run state for resume
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/procedure-runs/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();

      const [steps, sections, completions] = await Promise.all([
        db.query.procedureSteps.findMany({
          where: eq(schema.procedureSteps.documentId, ctx.document.id),
          orderBy: [
            asc(schema.procedureSteps.orderingHint),
            asc(schema.procedureSteps.createdAt),
          ],
        }),
        db.query.procedureSections.findMany({
          where: eq(schema.procedureSections.documentId, ctx.document.id),
          orderBy: [
            asc(schema.procedureSections.orderingHint),
            asc(schema.procedureSections.createdAt),
          ],
        }),
        db.query.procedureStepCompletions.findMany({
          where: eq(schema.procedureStepCompletions.runId, ctx.run.id),
        }),
      ]);

      return {
        run: runToDTO(ctx.run),
        document: {
          id: ctx.document.id,
          title: ctx.document.title,
          kind: ctx.document.kind,
          safetyCritical: ctx.document.safetyCritical,
        },
        sections: sections.map(sectionToDTO),
        steps: await stepsToDTOWithExpansion(db, steps),
        completions: completions.map(completionToDTO),
      };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /procedure-runs/:id/steps/:stepId — record completion or skip.
  // Upserts on (runId, stepId). Validates the discriminator vs the step's
  // declared evidence requirements. Updates run.lastActivityAt.
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string; stepId: string };
    Body: z.infer<typeof StepPatchBody>;
  }>(
    '/procedure-runs/:id/steps/:stepId',
    {
      schema: {
        params: z.object({ id: UuidSchema, stepId: UuidSchema }),
        body: StepPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      if (ctx.run.status !== 'in_progress') {
        return reply.conflict(
          `Run is ${ctx.run.status}; only in_progress runs accept step updates.`,
        );
      }

      const step = await db.query.procedureSteps.findFirst({
        where: eq(schema.procedureSteps.id, request.params.stepId),
      });
      if (!step) return reply.notFound();
      if (step.documentId !== ctx.document.id) {
        // Cross-doc step would let a malicious caller stamp evidence
        // against any step they can guess. Treat as not-found.
        return reply.notFound();
      }

      const body = request.body;
      const enteredAt = new Date(body.enteredAt);
      const completedAt = new Date();
      const timeMs = Math.max(0, completedAt.getTime() - enteredAt.getTime());

      const insertValues: typeof schema.procedureStepCompletions.$inferInsert = {
        runId: ctx.run.id,
        stepId: step.id,
        outcome: body.outcome,
        skipReason: null,
        photos: [],
        numericValue: null,
        passFailValue: null,
        textValue: null,
        measurementOutOfSpec: false,
        measurementOverrideReason: null,
        notes: body.notes ?? null,
        enteredAt,
        completedAt,
        timeMs,
      };

      if (body.outcome === 'skipped') {
        insertValues.skipReason = body.skipReason;
        // Skipping a safety-critical step requires explicit notes — a free-
        // text justification beyond the skipReason itself.
        if (step.safetyCritical && !body.notes) {
          return reply.badRequest(
            'Skipping a safety-critical step requires notes explaining why.',
          );
        }
      } else {
        // outcome = 'completed'
        // Photo requirement
        if (step.requiresPhoto && body.photos.length < step.minPhotoCount) {
          return reply.badRequest(
            `Step requires at least ${step.minPhotoCount} photo(s); got ${body.photos.length}.`,
          );
        }
        insertValues.photos = body.photos;

        // Measurement requirement / coherence
        if (step.kind === 'measurement_required') {
          if (!body.measurement) {
            return reply.badRequest('Measurement is required for this step.');
          }
          const spec = step.measurementSpec;
          if (!spec) {
            // Schema CHECK should prevent this state; defensive 500.
            return reply.internalServerError(
              'Step has measurement_required kind but no spec on file.',
            );
          }
          if (body.measurement.kind !== spec.kind) {
            return reply.badRequest(
              `Measurement kind mismatch: spec is ${spec.kind}, got ${body.measurement.kind}.`,
            );
          }
          if (body.measurement.kind === 'numeric') {
            // spec.kind === 'numeric' is guaranteed by the kind-match check
            // above, so the discriminated narrowing here is safe.
            const numericSpec = spec as Extract<typeof spec, { kind: 'numeric' }>;
            const evalResult = evaluateNumeric(body.measurement.value, numericSpec);
            if (evalResult.outOfSpec && !body.measurement.overrideReason) {
              return reply
                .code(400)
                .send({
                  statusCode: 400,
                  error: 'Bad Request',
                  message: `Value out of spec (${evalResult.reason}). Provide overrideReason to confirm.`,
                  measurementOutOfSpec: true,
                  reason: evalResult.reason,
                });
            }
            insertValues.numericValue = body.measurement.value;
            insertValues.measurementOutOfSpec = evalResult.outOfSpec;
            insertValues.measurementOverrideReason =
              body.measurement.overrideReason ?? null;
          } else if (body.measurement.kind === 'pass_fail') {
            insertValues.passFailValue = body.measurement.value;
          } else {
            insertValues.textValue = body.measurement.value;
          }
        } else if (body.measurement) {
          // Step doesn't require measurement but caller sent one — accept
          // it as evidence (e.g., free-text note about an instruction step
          // could come through as free_text), but don't enforce.
          if (body.measurement.kind === 'numeric') {
            insertValues.numericValue = body.measurement.value;
          } else if (body.measurement.kind === 'pass_fail') {
            insertValues.passFailValue = body.measurement.value;
          } else {
            insertValues.textValue = body.measurement.value;
          }
        }
      }

      // Upsert on (runId, stepId).
      const existing = await db.query.procedureStepCompletions.findFirst({
        where: and(
          eq(schema.procedureStepCompletions.runId, ctx.run.id),
          eq(schema.procedureStepCompletions.stepId, step.id),
        ),
      });

      let saved: CompletionRow;
      if (existing) {
        const [updated] = await db
          .update(schema.procedureStepCompletions)
          .set({
            outcome: insertValues.outcome,
            skipReason: insertValues.skipReason,
            photos: insertValues.photos,
            numericValue: insertValues.numericValue,
            passFailValue: insertValues.passFailValue,
            textValue: insertValues.textValue,
            measurementOutOfSpec: insertValues.measurementOutOfSpec,
            measurementOverrideReason: insertValues.measurementOverrideReason,
            notes: insertValues.notes,
            enteredAt: insertValues.enteredAt,
            completedAt: insertValues.completedAt,
            timeMs: insertValues.timeMs,
          })
          .where(eq(schema.procedureStepCompletions.id, existing.id))
          .returning();
        if (!updated) return reply.internalServerError();
        saved = updated;
      } else {
        const [created] = await db
          .insert(schema.procedureStepCompletions)
          .values(insertValues)
          .returning();
        if (!created) return reply.internalServerError();
        saved = created;
      }

      await db
        .update(schema.procedureRuns)
        .set({ lastActivityAt: completedAt })
        .where(eq(schema.procedureRuns.id, ctx.run.id));

      await audit(db, {
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType:
          body.outcome === 'skipped'
            ? 'procedure_run.step_skipped'
            : 'procedure_run.step_completed',
        targetId: ctx.run.id,
        payload: {
          stepId: step.id,
          outcome: body.outcome,
          timeMs,
          measurementOutOfSpec: saved.measurementOutOfSpec,
        },
        request,
      });

      return completionToDTO(saved);
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/steps/:stepId/photo — multipart upload, scoped
  // to the run owner. Returns { key, mime } for the client to attach to a
  // subsequent PATCH. We deliberately don't auto-bind to the completion
  // here: the client may capture multiple photos before tapping Mark Done.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string; stepId: string } }>(
    '/procedure-runs/:id/steps/:stepId/photo',
    { schema: { params: z.object({ id: UuidSchema, stepId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      if (ctx.run.status !== 'in_progress') {
        return reply.conflict('Run must be in_progress to upload photos.');
      }

      // Confirm the step is on the run's document — keeps callers from
      // posting evidence to the wrong run.
      const step = await db.query.procedureSteps.findFirst({
        where: eq(schema.procedureSteps.id, request.params.stepId),
      });
      if (!step || step.documentId !== ctx.document.id) return reply.notFound();

      const file = await request.file();
      if (!file) return reply.badRequest('Multipart file is required.');

      const mime = file.mimetype ?? '';
      if (!mime.startsWith('image/')) {
        return reply.badRequest('Only image/* uploads are accepted.');
      }

      const buffer = await file.toBuffer();
      const result = await storage.putBuffer({
        buffer,
        filename: file.filename ?? 'photo.jpg',
        contentType: mime,
      });

      return {
        key: result.storageKey,
        mime,
        size: result.size,
        url: storage.publicUrl(result.storageKey),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/finish — terminal "all done" transition.
  // Validates every required step has a 'completed' completion that
  // satisfies its evidence requirements. Returns 409 with missingStepIds
  // when something's incomplete.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/procedure-runs/:id/finish',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      if (ctx.run.status !== 'in_progress') {
        return reply.conflict(
          `Cannot finish a run in ${ctx.run.status} state. Resume first if paused.`,
        );
      }

      const steps = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, ctx.document.id),
      });
      const completions = await db.query.procedureStepCompletions.findMany({
        where: eq(schema.procedureStepCompletions.runId, ctx.run.id),
      });
      const completionByStep = new Map(completions.map((c) => [c.stepId, c]));

      const missingStepIds: string[] = [];
      for (const step of steps) {
        const c = completionByStep.get(step.id);
        if (!c) {
          missingStepIds.push(step.id);
          continue;
        }
        if (c.outcome === 'skipped') {
          // Skipped is acceptable as long as the row exists with a reason
          // (the PATCH validated this).
          continue;
        }
        // Re-validate evidence requirements at finish time — defensive,
        // catches the case where a step's spec was edited mid-run.
        if (step.requiresPhoto && (c.photos?.length ?? 0) < step.minPhotoCount) {
          missingStepIds.push(step.id);
          continue;
        }
        if (step.kind === 'measurement_required') {
          const spec = step.measurementSpec;
          if (!spec) continue; // schema CHECK should prevent.
          if (
            spec.kind === 'numeric' &&
            c.numericValue == null
          ) {
            missingStepIds.push(step.id);
            continue;
          }
          if (
            spec.kind === 'pass_fail' &&
            c.passFailValue == null
          ) {
            missingStepIds.push(step.id);
            continue;
          }
          if (spec.kind === 'free_text' && c.textValue == null) {
            missingStepIds.push(step.id);
            continue;
          }
        }
      }

      if (missingStepIds.length > 0) {
        return reply
          .code(409)
          .send({
            statusCode: 409,
            error: 'Conflict',
            message: 'Run has incomplete required steps.',
            missingStepIds,
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

      await audit(db, {
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.finished',
        targetId: ctx.run.id,
        payload: {
          documentId: ctx.document.id,
          totalActiveMs: updated.totalActiveMs,
          stepCount: steps.length,
        },
        request,
      });

      return runToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/pause
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/procedure-runs/:id/pause',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      if (ctx.run.status !== 'in_progress') {
        return reply.conflict(`Cannot pause a run in ${ctx.run.status} state.`);
      }

      const now = new Date();
      const [updated] = await db
        .update(schema.procedureRuns)
        .set({ status: 'paused', pausedAt: now, lastActivityAt: now })
        .where(eq(schema.procedureRuns.id, ctx.run.id))
        .returning();
      if (!updated) return reply.internalServerError();

      await audit(db, {
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.paused',
        targetId: ctx.run.id,
        payload: {},
        request,
      });

      return runToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/resume — accumulates pause duration into
  // totalActiveMs to keep run-level wall-clock honest.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/procedure-runs/:id/resume',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      if (ctx.run.status !== 'paused') {
        return reply.conflict(`Cannot resume a run in ${ctx.run.status} state.`);
      }

      const now = new Date();
      // Active time accumulates while in_progress. We keep totalActiveMs
      // as "active wall-clock so far" — when transitioning from paused to
      // in_progress, we don't ADD to it (no time was active during pause).
      // The accumulation happens on the next pause/finish transition.
      // For v1 simplicity, totalActiveMs is updated only at terminal
      // events; lastActivityAt covers the resume-tracking need.
      const [updated] = await db
        .update(schema.procedureRuns)
        .set({ status: 'in_progress', pausedAt: null, lastActivityAt: now })
        .where(eq(schema.procedureRuns.id, ctx.run.id))
        .returning();
      if (!updated) return reply.internalServerError();

      await audit(db, {
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.resumed',
        targetId: ctx.run.id,
        payload: {},
        request,
      });

      return runToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // POST /procedure-runs/:id/abandon — terminal "give up" transition.
  // Allowed from in_progress or paused. Reason is required so the
  // capture loop can later cluster reasons (e.g., "missing tool",
  // "part not in stock").
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof AbandonBody>;
  }>(
    '/procedure-runs/:id/abandon',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: AbandonBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadRunForOwner(db, request.params.id, auth);
      if (!ctx) return reply.notFound();
      if (ctx.run.status !== 'in_progress' && ctx.run.status !== 'paused') {
        return reply.conflict(`Cannot abandon a run in ${ctx.run.status} state.`);
      }

      const now = new Date();
      const [updated] = await db
        .update(schema.procedureRuns)
        .set({
          status: 'abandoned',
          abandonedReason: request.body.reason,
          completedAt: now,
          lastActivityAt: now,
        })
        .where(eq(schema.procedureRuns.id, ctx.run.id))
        .returning();
      if (!updated) return reply.internalServerError();

      await audit(db, {
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_run.abandoned',
        targetId: ctx.run.id,
        payload: { reason: request.body.reason },
        request,
      });

      return runToDTO(updated);
    },
  );
}
