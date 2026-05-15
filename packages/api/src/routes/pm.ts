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
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
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
}
