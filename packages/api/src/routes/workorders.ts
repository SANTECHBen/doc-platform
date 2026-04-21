import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope } from '../middleware/scope';

const SeverityEnum = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const StatusEnum = z.enum([
  'open',
  'acknowledged',
  'in_progress',
  'blocked',
  'resolved',
  'closed',
]);
const OPEN_STATUSES = ['open', 'acknowledged', 'in_progress', 'blocked'] as const;

export async function registerWorkOrderRoutes(app: FastifyInstance) {
  // List work orders for an asset instance. ?status=open to filter.
  app.get<{
    Params: { id: string };
    Querystring: { status?: 'open' | 'all' };
  }>(
    '/asset-instances/:id/work-orders',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        querystring: z.object({ status: z.enum(['open', 'all']).optional() }),
      },
    },
    async (request) => {
      const { db } = app.ctx;
      const rows = await db
        .select()
        .from(schema.workOrders)
        .where(
          request.query.status === 'all'
            ? eq(schema.workOrders.assetInstanceId, request.params.id)
            : and(
                eq(schema.workOrders.assetInstanceId, request.params.id),
                inArray(schema.workOrders.status, [...OPEN_STATUSES]),
              ),
        )
        .orderBy(desc(schema.workOrders.openedAt));

      if (rows.length === 0) return [];

      const userIds = [
        ...new Set(
          rows
            .flatMap((r) => [r.openedByUserId, r.assignedToUserId])
            .filter((id): id is string => id !== null),
        ),
      ];
      const users = userIds.length
        ? await db.query.users.findMany({
            where: inArray(schema.users.id, userIds),
          })
        : [];
      const userById = new Map(users.map((u) => [u.id, u]));

      const { storage } = app.ctx;
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        severity: r.severity,
        openedAt: r.openedAt,
        resolvedAt: r.resolvedAt,
        closedAt: r.closedAt,
        attachments: (r.attachments ?? []).map((a) => ({
          key: a.key,
          mime: a.mime,
          caption: a.caption,
          url: storage.publicUrl(a.key),
        })),
        openedBy: r.openedByUserId
          ? {
              id: r.openedByUserId,
              displayName:
                userById.get(r.openedByUserId)?.displayName ?? 'Unknown',
            }
          : null,
        assignedTo: r.assignedToUserId
          ? {
              id: r.assignedToUserId,
              displayName:
                userById.get(r.assignedToUserId)?.displayName ?? 'Unknown',
            }
          : null,
      }));
    },
  );

  // Create a new work order. Fires an audit event for the opener's org.
  app.post<{
    Body: {
      assetInstanceId: string;
      title: string;
      description?: string;
      severity?: z.infer<typeof SeverityEnum>;
      attachments?: Array<{ key: string; mime: string; caption?: string }>;
    };
  }>(
    '/work-orders',
    {
      schema: {
        body: z.object({
          assetInstanceId: UuidSchema,
          title: z.string().min(3).max(200),
          description: z.string().max(4000).optional(),
          severity: SeverityEnum.optional(),
          attachments: z
            .array(
              z.object({
                key: z.string().max(400),
                mime: z.string().max(120),
                caption: z.string().max(200).optional(),
              }),
            )
            .max(10)
            .optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.body.assetInstanceId),
        with: { site: { with: { organization: true } } },
      });
      if (!instance) return reply.notFound('Asset instance not found.');
      // Scope check: can't open a work order against an instance outside your
      // org tree. 404 (not 403) so a scoped caller can't probe for existence.
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.notFound('Asset instance not found.');
      }

      const [created] = await db
        .insert(schema.workOrders)
        .values({
          assetInstanceId: instance.id,
          openedByUserId: auth.userId,
          title: request.body.title,
          description: request.body.description ?? null,
          severity: request.body.severity ?? 'medium',
          status: 'open',
          attachments: request.body.attachments ?? [],
        })
        .returning();
      if (!created) return reply.internalServerError();

      await db.insert(schema.auditEvents).values({
        organizationId: instance.site.organization.id,
        actorUserId: auth.userId,
        eventType: 'work_order.opened',
        targetType: 'work_order',
        targetId: created.id,
        payload: {
          title: created.title,
          severity: created.severity,
          assetInstanceId: instance.id,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return created;
    },
  );

  // Status transition + assignment. Either field may be updated.
  app.patch<{
    Params: { id: string };
    Body: { status?: z.infer<typeof StatusEnum>; assignedToUserId?: string | null };
  }>(
    '/work-orders/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z
          .object({
            status: StatusEnum.optional(),
            assignedToUserId: UuidSchema.nullable().optional(),
          })
          .refine((b) => b.status !== undefined || b.assignedToUserId !== undefined, {
            message: 'At least one of status or assignedToUserId must be provided.',
          }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const wo = await db.query.workOrders.findFirst({
        where: eq(schema.workOrders.id, request.params.id),
        with: { assetInstance: { with: { site: { with: { organization: true } } } } },
      });
      if (!wo) return reply.notFound();
      // Scope check: mutating a work order outside your scope is a 404 to
      // avoid leaking existence of the row.
      if (!scope.all && !scope.orgIds.includes(wo.assetInstance.site.organizationId)) {
        return reply.notFound();
      }

      const now = new Date();
      const patch: Partial<typeof schema.workOrders.$inferInsert> = {};
      if (request.body.status !== undefined) {
        patch.status = request.body.status;
        if (request.body.status === 'resolved' && !wo.resolvedAt) patch.resolvedAt = now;
        if (request.body.status === 'closed' && !wo.closedAt) patch.closedAt = now;
      }
      if (request.body.assignedToUserId !== undefined) {
        patch.assignedToUserId = request.body.assignedToUserId;
      }

      const [updated] = await db
        .update(schema.workOrders)
        .set(patch)
        .where(eq(schema.workOrders.id, wo.id))
        .returning();

      if (request.body.status !== undefined && request.body.status !== wo.status) {
        await db.insert(schema.auditEvents).values({
          organizationId: wo.assetInstance.site.organization.id,
          actorUserId: auth.userId,
          eventType: 'work_order.status_changed',
          targetType: 'work_order',
          targetId: wo.id,
          payload: { from: wo.status, to: request.body.status },
        });
      }

      return updated;
    },
  );
}
