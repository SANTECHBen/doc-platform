// Field-tech PM endpoints. Read by the PWA via scan session, written by
// authenticated users (techs sign in to log a service performed).
//
// Surface:
//   GET  /assets/:instanceId/pm-status
//   POST /assets/:instanceId/pm-service-records
//
// Read is open via scan session OR auth; the asset's organizationId
// must match the scan session or be in the user's auth scope. Write
// requires real auth — every service record carries an attributed
// user, and scan sessions are anonymous by design.

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, PM_PLAN_FREQUENCY_DAYS, PM_PLAN_FREQUENCY_LABEL, type PmPlanFrequency } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import {
  getEffectiveOrgScope,
  requireAuthOrScan,
} from '../middleware/scan-session';
import { computePmStatusForInstance } from './admin-pm';

const CreateServiceRecordBody = z.object({
  pmScheduleId: UuidSchema.nullable().optional(),
  documentId: UuidSchema.nullable().optional(),
  procedureRunId: UuidSchema.nullable().optional(),
  performedAt: z
    .string()
    .datetime()
    .optional()
    .describe('ISO timestamp; defaults to now'),
  notes: z.string().max(2000).nullable().optional(),
});

const FrequencyEnum = z.enum(['D', 'W', 'M', 'Q', 'S', 'Y']);

const CreatePlanServiceRecordBody = z.object({
  planId: UuidSchema,
  frequency: FrequencyEnum,
  performedAt: z.string().datetime().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// Calendar-day diff using UTC midnight. Used by the plan-bucket
// status calc to avoid ms-level floor underflow when (now - anchor)
// is sub-millisecond. See the call site in computePmPlanStatusForInstance.
function utcDayDiff(from: Date, to: Date): number {
  const a = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  );
  const b = Date.UTC(
    to.getUTCFullYear(),
    to.getUTCMonth(),
    to.getUTCDate(),
  );
  return Math.floor((b - a) / 86_400_000);
}

export async function registerPmRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  // ------------------------------------------------------------------
  // GET /assets/:instanceId/pm-status
  // ------------------------------------------------------------------
  app.get<{ Params: { instanceId: string } }>(
    '/assets/:instanceId/pm-status',
    { schema: { params: z.object({ instanceId: UuidSchema }) } },
    async (request, reply) => {
      requireAuthOrScan(request);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.instanceId),
        with: { site: true, model: true },
      });
      if (!instance) return reply.code(404).send({ error: 'not_found' });

      // Authorize: either the scan session is for this instance's org,
      // or the auth'd user has scope to it. Treat mismatches as 404
      // to keep the same opacity the rest of the API uses.
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.code(401).send({ error: 'unauthorized' });
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return computePmStatusForInstance(db, instance);
    },
  );

  // ------------------------------------------------------------------
  // POST /assets/:instanceId/pm-service-records
  //
  // Logs that a tech performed maintenance — either by running the
  // associated procedure to completion (procedureRunId supplied) or by
  // marking it done off-system (no run id). pmScheduleId is optional;
  // omitted = ad-hoc service that wasn't on a planned schedule.
  // ------------------------------------------------------------------
  app.post<{
    Params: { instanceId: string };
    Body: z.infer<typeof CreateServiceRecordBody>;
  }>(
    '/assets/:instanceId/pm-service-records',
    {
      schema: {
        params: z.object({ instanceId: UuidSchema }),
        body: CreateServiceRecordBody,
      },
    },
    async (request, reply) => {
      // Writes always need real auth — service records are attributed
      // evidence of work; we don't accept anonymous scan-session
      // submissions for them.
      requireAuth(request);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.instanceId),
        with: { site: true },
      });
      if (!instance) return reply.code(404).send({ error: 'not_found' });

      // The user must have scope to the instance's org.
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.code(401).send({ error: 'unauthorized' });
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Cross-check the optional schedule belongs to this instance's
      // model — otherwise the record would link to an unrelated plan.
      if (request.body.pmScheduleId) {
        const sched = await db.query.pmSchedules.findFirst({
          where: eq(schema.pmSchedules.id, request.body.pmScheduleId),
        });
        if (!sched || sched.assetModelId !== instance.assetModelId) {
          return reply.code(400).send({
            error: 'invalid_schedule_for_instance',
            message:
              "pmScheduleId references a schedule that doesn't belong to this instance's asset model.",
          });
        }
      }

      const inserted = (
        await db
          .insert(schema.pmServiceRecords)
          .values({
            assetInstanceId: instance.id,
            pmScheduleId: request.body.pmScheduleId ?? null,
            documentId: request.body.documentId ?? null,
            procedureRunId: request.body.procedureRunId ?? null,
            performedByUserId: request.auth!.userId,
            performedAt: request.body.performedAt
              ? new Date(request.body.performedAt)
              : new Date(),
            notes: request.body.notes ?? null,
          })
          .returning()
      )[0];
      if (!inserted) {
        return reply.code(500).send({ error: 'insert_returned_no_row' });
      }

      return reply.code(201).send({
        id: inserted.id,
        assetInstanceId: inserted.assetInstanceId,
        pmScheduleId: inserted.pmScheduleId,
        documentId: inserted.documentId,
        procedureRunId: inserted.procedureRunId,
        performedAt: inserted.performedAt.toISOString(),
        notes: inserted.notes,
        createdAt: inserted.createdAt.toISOString(),
      });
    },
  );

  // ------------------------------------------------------------------
  // GET /assets/:instanceId/pm-plan-status
  //
  // Returns the asset's PM Plans + items + per-(plan, frequency) status
  // for the field tech UI. One bucket per frequency-band per plan; the
  // tech sees one card per bucket in the PWA's "Due" / "Coming up"
  // sections alongside flat schedule cards.
  // ------------------------------------------------------------------
  app.get<{ Params: { instanceId: string } }>(
    '/assets/:instanceId/pm-plan-status',
    { schema: { params: z.object({ instanceId: UuidSchema }) } },
    async (request, reply) => {
      requireAuthOrScan(request);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.instanceId),
        with: { site: true, model: true },
      });
      if (!instance) return reply.code(404).send({ error: 'not_found' });
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.code(401).send({ error: 'unauthorized' });
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return computePmPlanStatusForInstance(db, instance.id, instance.assetModelId, instance.installedAt);
    },
  );

  // ------------------------------------------------------------------
  // POST /assets/:instanceId/pm-plan-service-records
  //
  // Tech marks a (plan, frequency) bucket performed — one tap covers
  // all items in that frequency band. Service-record is the anchor for
  // the next-due calculation.
  // ------------------------------------------------------------------
  app.post<{
    Params: { instanceId: string };
    Body: z.infer<typeof CreatePlanServiceRecordBody>;
  }>(
    '/assets/:instanceId/pm-plan-service-records',
    {
      schema: {
        params: z.object({ instanceId: UuidSchema }),
        body: CreatePlanServiceRecordBody,
      },
    },
    async (request, reply) => {
      requireAuth(request);
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.instanceId),
        with: { site: true },
      });
      if (!instance) return reply.code(404).send({ error: 'not_found' });
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.code(401).send({ error: 'unauthorized' });
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Cross-check the plan belongs to this instance's asset model.
      const plan = await db.query.pmPlans.findFirst({
        where: eq(schema.pmPlans.id, request.body.planId),
      });
      if (!plan || plan.assetModelId !== instance.assetModelId) {
        return reply.code(400).send({
          error: 'invalid_plan_for_instance',
          message:
            "planId references a plan that doesn't belong to this instance's asset model.",
        });
      }

      const [inserted] = await db
        .insert(schema.pmPlanServiceRecords)
        .values({
          assetInstanceId: instance.id,
          planId: plan.id,
          frequency: request.body.frequency,
          performedByUserId: request.auth!.userId,
          performedAt: request.body.performedAt
            ? new Date(request.body.performedAt)
            : new Date(),
          notes: request.body.notes ?? null,
        })
        .returning();
      if (!inserted) {
        return reply.code(500).send({ error: 'insert_returned_no_row' });
      }
      return reply.code(201).send({
        id: inserted.id,
        assetInstanceId: inserted.assetInstanceId,
        planId: inserted.planId,
        frequency: inserted.frequency,
        performedAt: inserted.performedAt.toISOString(),
        notes: inserted.notes,
        createdAt: inserted.createdAt.toISOString(),
      });
    },
  );

  // ------------------------------------------------------------------
  // GET /assets/:instanceId/troubleshooting
  //
  // Returns the troubleshooting guides + items for the instance's asset
  // model. Read-only — the PWA renders symptoms in a list; tapping a
  // row reveals cause + remedy, and rows with a linked procedure launch
  // VirtualJobAid the same way the procedure library does.
  // ------------------------------------------------------------------
  app.get<{ Params: { instanceId: string } }>(
    '/assets/:instanceId/troubleshooting',
    { schema: { params: z.object({ instanceId: UuidSchema }) } },
    async (request, reply) => {
      requireAuthOrScan(request);
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.instanceId),
        with: { site: true, model: true },
      });
      if (!instance) return reply.code(404).send({ error: 'not_found' });
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.code(401).send({ error: 'unauthorized' });
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const guides = await db.query.troubleshootingGuides.findMany({
        where: and(
          eq(schema.troubleshootingGuides.assetModelId, instance.assetModelId),
          eq(schema.troubleshootingGuides.disabled, false),
        ),
        orderBy: [
          asc(schema.troubleshootingGuides.orderingHint),
          asc(schema.troubleshootingGuides.createdAt),
        ],
      });
      if (guides.length === 0) return { guides: [] };

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
      // Resolve titles for every documentId referenced across all
      // structured shapes — paired causes (canonical) + legacy
      // causeItems/remedyItems — in a single query so the PWA renders
      // Run-button labels without per-item round trips.
      type StructItem = { text: string; documentId?: string | null };
      type RemedyStep = { text: string; documentId?: string | null };
      type PairedCause = {
        cause: string;
        // Pre-0029 single-string remedy. Normalized into remedySteps
        // on read so the PWA only has to render one shape.
        remedy?: string | null;
        remedySteps?: RemedyStep[];
        remedyStyle?: 'bullet' | 'numbered';
        documentId?: string | null;
      };
      const allItemDocIds = [
        ...new Set(
          items.flatMap((it) => {
            const struct = [
              ...((it.causeItems ?? []) as StructItem[]),
              ...((it.remedyItems ?? []) as StructItem[]),
            ];
            const paired = (it.causes ?? []) as PairedCause[];
            const pairedDocIds = paired.flatMap((p) => [
              p.documentId ?? null,
              ...(p.remedySteps ?? []).map((s) => s.documentId ?? null),
            ]);
            return [
              ...struct.map((s) => s.documentId ?? null),
              ...pairedDocIds,
            ].filter((id): id is string => id !== null);
          }),
        ),
      ];
      const itemDocs = allItemDocIds.length
        ? await db.query.documents.findMany({
            where: inArray(schema.documents.id, allItemDocIds),
            columns: { id: true, title: true },
          })
        : [];
      const itemDocById = new Map(itemDocs.map((d) => [d.id, d]));
      const resolveDoc = (id: string | null | undefined) =>
        id && itemDocById.has(id)
          ? { id, title: itemDocById.get(id)!.title }
          : null;
      const resolveStruct = (arr: StructItem[]) =>
        arr.map((s) => ({
          text: s.text,
          document: resolveDoc(s.documentId ?? null),
        }));
      const resolvePaired = (arr: PairedCause[]) =>
        arr.map((p) => {
          // Migrate-on-read: a pre-0029 entry has a `remedy` string but
          // no remedySteps. Surface it as a single bullet step so the
          // PWA only needs one render path. The per-cause documentId
          // (also pre-0029) becomes the step's link.
          const steps =
            p.remedySteps && p.remedySteps.length > 0
              ? p.remedySteps
              : p.remedy
                ? [{ text: p.remedy, documentId: p.documentId ?? null }]
                : [];
          return {
            cause: p.cause,
            remedyStyle: p.remedyStyle ?? 'bullet',
            remedySteps: steps.map((s) => ({
              text: s.text,
              document: resolveDoc(s.documentId ?? null),
            })),
          };
        });

      return {
        guides: guides.map((g) => ({
          guide: { id: g.id, name: g.name, description: g.description },
          items: items
            .filter((it) => it.guideId === g.id)
            .map((it) => ({
              id: it.id,
              symptom: it.symptom,
              cause: it.cause,
              remedy: it.remedy,
              causeItems: resolveStruct((it.causeItems ?? []) as StructItem[]),
              remedyItems: resolveStruct((it.remedyItems ?? []) as StructItem[]),
              causes: resolvePaired((it.causes ?? []) as PairedCause[]),
              document: it.document
                ? { id: it.document.id, title: it.document.title }
                : null,
            })),
        })),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Per-frequency PM Plan status — derived at query time, no stored next-due.
// ---------------------------------------------------------------------------

type PmPlanBucketStatus = 'overdue' | 'due' | 'soon' | 'upcoming';

async function computePmPlanStatusForInstance(
  db: import('@platform/db').Database,
  assetInstanceId: string,
  assetModelId: string,
  installedAt: Date | null,
): Promise<{
  plans: Array<{
    plan: {
      id: string;
      name: string;
      description: string | null;
    };
    /** One entry per frequency band that has items. Buckets with zero
     *  items are omitted entirely so the PWA doesn't render empty cards. */
    buckets: Array<{
      frequency: PmPlanFrequency;
      frequencyLabel: string;
      itemCount: number;
      items: Array<{
        id: string;
        component: string;
        checkText: string;
        remarks: string | null;
        document: { id: string; title: string; kind: string } | null;
      }>;
      lastPerformedAt: string | null;
      lastPerformedById: string | null;
      nextDueAt: string;
      daysUntilDue: number;
      status: PmPlanBucketStatus;
      needsAction: boolean;
    }>;
  }>;
}> {
  // 1. All non-disabled plans for this model.
  const plans = await db.query.pmPlans.findMany({
    where: and(
      eq(schema.pmPlans.assetModelId, assetModelId),
      eq(schema.pmPlans.disabled, false),
    ),
    orderBy: [asc(schema.pmPlans.orderingHint), asc(schema.pmPlans.createdAt)],
  });
  if (plans.length === 0) return { plans: [] };

  // 2. All items, joined with optional document.
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

  // 3. Latest service record per (plan, frequency) for this instance.
  const records = await db.query.pmPlanServiceRecords.findMany({
    where: and(
      eq(schema.pmPlanServiceRecords.assetInstanceId, assetInstanceId),
      inArray(
        schema.pmPlanServiceRecords.planId,
        plans.map((p) => p.id),
      ),
    ),
    orderBy: [desc(schema.pmPlanServiceRecords.performedAt)],
  });
  const lastByKey = new Map<
    string,
    typeof schema.pmPlanServiceRecords.$inferSelect
  >();
  for (const r of records) {
    if (!r.planId) continue;
    const k = `${r.planId}:${r.frequency}`;
    if (!lastByKey.has(k)) lastByKey.set(k, r);
  }

  const now = new Date();
  const out = plans.map((p) => {
    // Bucket items by frequency for this plan only. Skip empty drafts
    // (checkText === '') so techs never see "(empty)" rows in their
    // checklist — admins create empty rows via the inline "Add check"
    // affordance, then fill them in. Until they have text, they shouldn't
    // count toward "Daily checks (N items)" or appear in the expanded list.
    const planItems = items.filter(
      (it) => it.planId === p.id && it.checkText.trim().length > 0,
    );
    const byFreq = new Map<PmPlanFrequency, typeof planItems>();
    for (const it of planItems) {
      const f = it.frequency as PmPlanFrequency;
      const arr = byFreq.get(f) ?? [];
      arr.push(it);
      byFreq.set(f, arr);
    }
    // Render buckets in frequency-day order (D first, Y last) — matches
    // the natural reading order in OEM checklists.
    const order: PmPlanFrequency[] = ['D', 'W', 'M', 'Q', 'S', 'Y'];
    const buckets = order
      .filter((f) => (byFreq.get(f)?.length ?? 0) > 0)
      .map((f) => {
        const bucketItems = byFreq.get(f) ?? [];
        const last = lastByKey.get(`${p.id}:${f}`);
        const cadenceDays = PM_PLAN_FREQUENCY_DAYS[f];
        // Anchor: last performance, else instance install date, else
        // plan creation date. Same pattern as pm-status.ts.
        const anchor =
          last?.performedAt ?? installedAt ?? p.createdAt;
        const nextDueMs =
          anchor.getTime() + cadenceDays * 24 * 60 * 60 * 1000;
        const nextDueAt = new Date(nextDueMs);
        // Calendar-day diff at UTC midnight, NOT ms-floor. The prior
        // ms math under-flowed when (now - anchor) was sub-millisecond:
        // a Daily bucket marked at 10:00:00 returning at 10:00:00.234
        // gave msUntilDue = 86_399_766 → floor / 86_400_000 = 0 →
        // status 'due', leaving the just-marked item still reading as
        // "Due today" on the PWA card. Day-diff gives 1 → status 'soon'.
        const daysUntilDue = utcDayDiff(now, nextDueAt);
        const status: PmPlanBucketStatus =
          daysUntilDue < 0
            ? 'overdue'
            : daysUntilDue === 0
              ? 'due'
              : daysUntilDue <= 7
                ? 'soon'
                : 'upcoming';
        return {
          frequency: f,
          frequencyLabel: PM_PLAN_FREQUENCY_LABEL[f],
          itemCount: bucketItems.length,
          items: bucketItems.map((it) => ({
            id: it.id,
            component: it.component,
            checkText: it.checkText,
            remarks: it.remarks,
            document: it.document
              ? {
                  id: it.document.id,
                  title: it.document.title,
                  kind: it.document.kind,
                }
              : null,
          })),
          lastPerformedAt: last?.performedAt.toISOString() ?? null,
          lastPerformedById: last?.performedByUserId ?? null,
          nextDueAt: nextDueAt.toISOString(),
          daysUntilDue,
          status,
          needsAction: status === 'overdue' || status === 'due',
        };
      });
    return {
      plan: { id: p.id, name: p.name, description: p.description },
      buckets,
    };
  });
  return { plans: out };
}
