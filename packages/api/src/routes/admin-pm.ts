// Admin authoring API for Preventive Maintenance schedules + read-only
// status aggregation per asset instance.
//
// Surface:
//   GET    /admin/asset-models/:modelId/pm-schedules       list schedules on a model
//   POST   /admin/asset-models/:modelId/pm-schedules       create
//   PATCH  /admin/pm-schedules/:scheduleId                 update / toggle disabled
//   DELETE /admin/pm-schedules/:scheduleId                 hard delete (records survive via FK set null)
//   GET    /admin/asset-instances/:instanceId/pm-status    due / overdue / coming up + history
//
// All writes go through requireAuth + requireOrgInScope on the model's
// owner organization, mirroring admin-procedure-steps.ts.

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, PM_PLAN_FREQUENCY_LABEL, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';
import {
  computeScheduleStatus,
  type ScheduleStatusInput,
} from '../lib/pm-status';

// ---------------------------------------------------------------------------
// Zod request schemas
// ---------------------------------------------------------------------------

const CadenceKindEnum = z.enum(['days']);

const CreateScheduleBody = z.object({
  documentId: UuidSchema.nullable().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  cadenceKind: CadenceKindEnum.default('days'),
  cadenceValue: z.number().int().min(1).max(3650), // up to 10 years
  graceDays: z.number().int().min(0).max(365).default(0),
  disabled: z.boolean().default(false),
});

const UpdateScheduleBody = CreateScheduleBody.partial();

// ---------------------------------------------------------------------------
// Helpers — load + scope
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

async function loadScheduleForWrite(
  db: Database,
  scheduleId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  schedule: typeof schema.pmSchedules.$inferSelect;
  model: typeof schema.assetModels.$inferSelect;
} | null> {
  const s = await db.query.pmSchedules.findFirst({
    where: eq(schema.pmSchedules.id, scheduleId),
  });
  if (!s) return null;
  const m = await db.query.assetModels.findFirst({
    where: eq(schema.assetModels.id, s.assetModelId),
  });
  if (!m) return null;
  requireOrgInScope(scope, m.ownerOrganizationId);
  return { schedule: s, model: m };
}

function scheduleToDTO(s: typeof schema.pmSchedules.$inferSelect) {
  return {
    id: s.id,
    assetModelId: s.assetModelId,
    documentId: s.documentId,
    name: s.name,
    description: s.description,
    cadenceKind: s.cadenceKind,
    cadenceValue: s.cadenceValue,
    graceDays: s.graceDays,
    disabled: s.disabled,
    createdByUserId: s.createdByUserId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminPm(app: FastifyInstance) {
  const { db } = app.ctx;

  // ------------------------------------------------------------------
  // GET /admin/asset-models/:modelId/pm-schedules
  // ------------------------------------------------------------------
  app.get<{ Params: { modelId: string } }>(
    '/admin/asset-models/:modelId/pm-schedules',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const model = await loadModelForWrite(db, request.params.modelId, scope);
      if (!model) return reply.code(404).send({ error: 'not_found' });

      const rows = await db.query.pmSchedules.findMany({
        where: eq(schema.pmSchedules.assetModelId, model.id),
        orderBy: [desc(schema.pmSchedules.createdAt)],
        with: { document: { columns: { id: true, title: true, kind: true } } },
      });

      return rows.map((r) => ({
        ...scheduleToDTO(r),
        document: r.document
          ? { id: r.document.id, title: r.document.title, kind: r.document.kind }
          : null,
      }));
    },
  );

  // ------------------------------------------------------------------
  // POST /admin/asset-models/:modelId/pm-schedules
  // ------------------------------------------------------------------
  app.post<{
    Params: { modelId: string };
    Body: z.infer<typeof CreateScheduleBody>;
  }>(
    '/admin/asset-models/:modelId/pm-schedules',
    {
      schema: {
        params: z.object({ modelId: UuidSchema }),
        body: CreateScheduleBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const model = await loadModelForWrite(db, request.params.modelId, scope);
      if (!model) return reply.code(404).send({ error: 'not_found' });

      // If a documentId is supplied it must reference a doc the user can
      // see. For now we trust the admin scope check; a deeper check
      // (doc.packVersion.pack.ownerOrganizationId in scope) is overkill
      // for v1 since cross-org doc linking is already a known scenario
      // for overlay packs.
      const inserted = (
        await db
          .insert(schema.pmSchedules)
          .values({
            assetModelId: model.id,
            documentId: request.body.documentId ?? null,
            name: request.body.name,
            description: request.body.description ?? null,
            cadenceKind: request.body.cadenceKind,
            cadenceValue: request.body.cadenceValue,
            graceDays: request.body.graceDays,
            disabled: request.body.disabled,
            createdByUserId: request.auth!.userId,
          })
          .returning()
      )[0];
      if (!inserted) {
        return reply.code(500).send({ error: 'insert_returned_no_row' });
      }
      return reply.code(201).send(scheduleToDTO(inserted));
    },
  );

  // ------------------------------------------------------------------
  // PATCH /admin/pm-schedules/:scheduleId
  // ------------------------------------------------------------------
  app.patch<{
    Params: { scheduleId: string };
    Body: z.infer<typeof UpdateScheduleBody>;
  }>(
    '/admin/pm-schedules/:scheduleId',
    {
      schema: {
        params: z.object({ scheduleId: UuidSchema }),
        body: UpdateScheduleBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadScheduleForWrite(
        db,
        request.params.scheduleId,
        scope,
      );
      if (!ctx) return reply.code(404).send({ error: 'not_found' });

      const patch: Partial<typeof schema.pmSchedules.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (request.body.documentId !== undefined)
        patch.documentId = request.body.documentId;
      if (request.body.name !== undefined) patch.name = request.body.name;
      if (request.body.description !== undefined)
        patch.description = request.body.description;
      if (request.body.cadenceKind !== undefined)
        patch.cadenceKind = request.body.cadenceKind;
      if (request.body.cadenceValue !== undefined)
        patch.cadenceValue = request.body.cadenceValue;
      if (request.body.graceDays !== undefined)
        patch.graceDays = request.body.graceDays;
      if (request.body.disabled !== undefined)
        patch.disabled = request.body.disabled;

      const updated = (
        await db
          .update(schema.pmSchedules)
          .set(patch)
          .where(eq(schema.pmSchedules.id, ctx.schedule.id))
          .returning()
      )[0];
      if (!updated) {
        return reply.code(500).send({ error: 'update_returned_no_row' });
      }
      return scheduleToDTO(updated);
    },
  );

  // ------------------------------------------------------------------
  // DELETE /admin/pm-schedules/:scheduleId
  // ------------------------------------------------------------------
  app.delete<{ Params: { scheduleId: string } }>(
    '/admin/pm-schedules/:scheduleId',
    { schema: { params: z.object({ scheduleId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadScheduleForWrite(
        db,
        request.params.scheduleId,
        scope,
      );
      if (!ctx) return reply.code(404).send({ error: 'not_found' });

      await db
        .delete(schema.pmSchedules)
        .where(eq(schema.pmSchedules.id, ctx.schedule.id));

      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------------
  // GET /admin/asset-models/:modelId/procedure-documents
  // Lists every structured_procedure document attached (via any version
  // of any content pack) to this asset model. Powers the PM schedule
  // form's "select procedure" picker without forcing the admin to know
  // about pack/version structure.
  // ------------------------------------------------------------------
  app.get<{ Params: { modelId: string } }>(
    '/admin/asset-models/:modelId/procedure-documents',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);
      const model = await loadModelForWrite(db, request.params.modelId, scope);
      if (!model) return reply.code(404).send({ error: 'not_found' });

      const docs = await db.query.documents.findMany({
        where: eq(schema.documents.kind, 'structured_procedure'),
        with: {
          packVersion: {
            with: {
              pack: { columns: { id: true, name: true, assetModelId: true } },
            },
          },
        },
      });
      // Filter in JS rather than via SQL join because the relation is
      // chained two levels deep and the v1 admin scale doesn't justify
      // a custom SQL join.
      const filtered = docs.filter(
        (d) => d.packVersion?.pack?.assetModelId === model.id,
      );
      return filtered.map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        contentPackVersionId: d.contentPackVersionId,
        contentPack: d.packVersion?.pack
          ? { id: d.packVersion.pack.id, name: d.packVersion.pack.name }
          : null,
        contentPackVersion: d.packVersion
          ? {
              id: d.packVersion.id,
              versionNumber: d.packVersion.versionNumber,
              versionLabel: d.packVersion.versionLabel,
            }
          : null,
      }));
    },
  );

  // ------------------------------------------------------------------
  // GET /admin/asset-instances/:instanceId/pm-status
  // Returns: { schedules: [...with status], history: [...recent records] }
  // ------------------------------------------------------------------
  app.get<{ Params: { instanceId: string } }>(
    '/admin/asset-instances/:instanceId/pm-status',
    { schema: { params: z.object({ instanceId: UuidSchema }) } },
    async (request, reply) => {
      requireAuth(request);
      const scope = await getScope(request, db);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.instanceId),
        with: { site: true, model: true },
      });
      if (!instance) return reply.code(404).send({ error: 'not_found' });
      requireOrgInScope(scope, instance.site.organizationId);

      return computePmStatusForInstance(db, instance);
    },
  );
}

// ---------------------------------------------------------------------------
// Shared compute used by both admin + PWA endpoints.
// ---------------------------------------------------------------------------

export async function computePmStatusForInstance(
  db: Database,
  instance: typeof schema.assetInstances.$inferSelect & {
    model: typeof schema.assetModels.$inferSelect;
    site: typeof schema.sites.$inferSelect;
  },
) {
  // 1. All non-disabled schedules for this asset model.
  const schedules = await db.query.pmSchedules.findMany({
    where: and(
      eq(schema.pmSchedules.assetModelId, instance.assetModelId),
      eq(schema.pmSchedules.disabled, false),
    ),
    orderBy: [desc(schema.pmSchedules.createdAt)],
    with: { document: { columns: { id: true, title: true, kind: true } } },
  });

  // 2. Latest service record per (instance, schedule). One pass over
  //    instance's records, keyed on pmScheduleId.
  const records = schedules.length
    ? await db.query.pmServiceRecords.findMany({
        where: and(
          eq(schema.pmServiceRecords.assetInstanceId, instance.id),
          inArray(
            schema.pmServiceRecords.pmScheduleId,
            schedules.map((s) => s.id),
          ),
        ),
        orderBy: [desc(schema.pmServiceRecords.performedAt)],
      })
    : [];
  const lastByScheduleId = new Map<
    string,
    typeof schema.pmServiceRecords.$inferSelect
  >();
  for (const r of records) {
    if (r.pmScheduleId && !lastByScheduleId.has(r.pmScheduleId)) {
      lastByScheduleId.set(r.pmScheduleId, r);
    }
  }

  const now = new Date();
  const decorated = schedules.map((s) => {
    const last = lastByScheduleId.get(s.id);
    const status = computeScheduleStatus({
      cadenceKind: s.cadenceKind,
      cadenceValue: s.cadenceValue,
      graceDays: s.graceDays,
      scheduleCreatedAt: s.createdAt,
      instanceInstalledAt: instance.installedAt,
      lastPerformedAt: last?.performedAt ?? null,
      now,
      timezone: instance.site.timezone,
    });
    return {
      schedule: {
        id: s.id,
        name: s.name,
        description: s.description,
        cadenceKind: s.cadenceKind,
        cadenceValue: s.cadenceValue,
        graceDays: s.graceDays,
        document: s.document
          ? { id: s.document.id, title: s.document.title, kind: s.document.kind }
          : null,
      },
      lastPerformedAt: last?.performedAt.toISOString() ?? null,
      lastPerformedById: last?.performedByUserId ?? null,
      nextDueAt: status.nextDueAt.toISOString(),
      daysUntilDue: status.daysUntilDue,
      status: status.status,
      needsAction: status.needsAction,
    };
  });

  // 3. Recent history — union of schedule-based PM records, plan-bucket PM
  //    records, AND completed structured-procedure runs (Removal &
  //    Replacement + Troubleshooting). PMs are marked via "Mark performed"
  //    and land in the two pm_*_service_records tables; R&R and
  //    Troubleshooting have no service-record table, so their completions
  //    live only in procedure_runs (status='completed'). A tech expects
  //    History to show every procedure they finished on the asset, not
  //    just PMs — so we fold those runs in here. PM-category runs are
  //    deliberately excluded to avoid double-counting against the PM
  //    service records above.
  const [scheduleHistory, planHistory, procedureHistory] = await Promise.all([
    db.query.pmServiceRecords.findMany({
      where: eq(schema.pmServiceRecords.assetInstanceId, instance.id),
      orderBy: [desc(schema.pmServiceRecords.performedAt)],
      limit: 20,
      with: {
        schedule: { columns: { id: true, name: true } },
        document: { columns: { id: true, title: true } },
        performedBy: { columns: { id: true, displayName: true } },
      },
    }),
    db.query.pmPlanServiceRecords.findMany({
      where: eq(schema.pmPlanServiceRecords.assetInstanceId, instance.id),
      orderBy: [desc(schema.pmPlanServiceRecords.performedAt)],
      limit: 20,
      with: {
        plan: { columns: { id: true, name: true } },
        performedBy: { columns: { id: true, displayName: true } },
      },
    }),
    db.query.procedureRuns.findMany({
      where: and(
        eq(schema.procedureRuns.assetInstanceId, instance.id),
        eq(schema.procedureRuns.status, 'completed'),
      ),
      orderBy: [desc(schema.procedureRuns.completedAt)],
      limit: 20,
      with: {
        document: {
          columns: { id: true, title: true, procedureMetadata: true },
        },
        user: { columns: { id: true, displayName: true } },
      },
    }),
  ]);

  // Merge + sort + cap at 20. Plan records carry a pmPlan field with
  // the bucket frequency so the PWA can render "Cleaning · Daily"
  // instead of an unlabeled row. `performedBy` is nullable because
  // anonymous PWA scan-session writes (the default org mode) don't
  // attribute to a user; the PWA renders those as "Field tech".
  type HistoryItem = {
    id: string;
    pmSchedule: { id: string; name: string } | null;
    pmPlan: { id: string; name: string; frequencyLabel: string } | null;
    // Set when this row is a completed R&R / Troubleshooting procedure run
    // (no service-record table exists for those). Mutually exclusive with
    // pmSchedule / pmPlan. `category` lets the PWA label the row.
    procedureRun: {
      id: string;
      category: 'removal_replacement' | 'troubleshooting';
    } | null;
    document: { id: string; title: string } | null;
    performedBy: { id: string; displayName: string } | null;
    performedAt: string;
    notes: string | null;
  };
  const merged: HistoryItem[] = [
    ...scheduleHistory.map(
      (h): HistoryItem => ({
        id: h.id,
        pmSchedule: h.schedule
          ? { id: h.schedule.id, name: h.schedule.name }
          : null,
        pmPlan: null,
        procedureRun: null,
        document: h.document
          ? { id: h.document.id, title: h.document.title }
          : null,
        performedBy: h.performedBy
          ? { id: h.performedBy.id, displayName: h.performedBy.displayName }
          : null,
        performedAt: h.performedAt.toISOString(),
        notes: h.notes,
      }),
    ),
    ...planHistory.map(
      (h): HistoryItem => ({
        id: h.id,
        pmSchedule: null,
        pmPlan: h.plan
          ? {
              id: h.plan.id,
              name: h.plan.name,
              frequencyLabel: PM_PLAN_FREQUENCY_LABEL[h.frequency],
            }
          : null,
        procedureRun: null,
        document: null,
        performedBy: h.performedBy
          ? { id: h.performedBy.id, displayName: h.performedBy.displayName }
          : null,
        performedAt: h.performedAt.toISOString(),
        notes: h.notes,
      }),
    ),
    // Completed R&R + Troubleshooting runs. Filter by the document's
    // authored category; PM-category runs are skipped (covered above by
    // service records) and runs whose document was deleted (documentId
    // set null → no category) are dropped since they can't be classified.
    // completedAt is non-null for status='completed' rows.
    ...procedureHistory
      .map((run): HistoryItem | null => {
        const category = run.document?.procedureMetadata?.category ?? null;
        if (category !== 'removal_replacement' && category !== 'troubleshooting') {
          return null;
        }
        return {
          id: run.id,
          pmSchedule: null,
          pmPlan: null,
          procedureRun: { id: run.id, category },
          document: run.document
            ? { id: run.document.id, title: run.document.title }
            : null,
          performedBy: run.user
            ? { id: run.user.id, displayName: run.user.displayName }
            : null,
          performedAt: (run.completedAt ?? run.startedAt).toISOString(),
          notes: null,
        };
      })
      .filter((x): x is HistoryItem => x !== null),
  ]
    .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
    .slice(0, 20);

  return {
    schedules: decorated,
    history: merged,
    summary: {
      overdue: decorated.filter((d) => d.status === 'overdue').length,
      due: decorated.filter((d) => d.status === 'due').length,
      soon: decorated.filter((d) => d.status === 'soon').length,
      upcoming: decorated.filter((d) => d.status === 'upcoming').length,
      needsActionCount: decorated.filter((d) => d.needsAction).length,
    },
  };
}
