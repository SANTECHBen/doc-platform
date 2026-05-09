import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getUsageSnapshot, resolveQuota, TIER_DEFAULTS } from '../lib/voice-quota';

// Admin-only. Lets platform admins see what an org has been spending on
// voice/AI, drill into recent usage rows, set or change a tier, and apply
// custom caps when a customer's contract calls for it. The org's own
// admins do NOT see this — pricing is between the customer and SANTECH.

const SetQuotaSchema = z.object({
  tier: z.enum(['free', 'standard', 'pro', 'enterprise', 'custom']),
  // Per-cap overrides — only honored when tier='custom', or used as the
  // soft-set when the tier already has a default of `null` (unlimited).
  // Pass `null` to mean unlimited; omit to leave the existing value.
  dailyTurnsCap: z.number().int().min(0).nullable().optional(),
  monthlyTtsCharCap: z.number().int().min(0).nullable().optional(),
  monthlyDollarCap: z.number().int().min(0).nullable().optional(),
  alertDailyDollarThreshold: z.number().int().min(0).nullable().optional(),
});

export async function registerAdminVoiceUsageRoutes(app: FastifyInstance) {
  function requirePlatformAdmin(request: import('fastify').FastifyRequest) {
    const auth = requireAuth(request);
    if (!auth.platformAdmin) {
      const err = new Error('Platform admin only') as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    return auth;
  }

  // GET /admin/orgs/:orgId/voice-usage
  // → today + month rollups, current quota, and the last 50 rows.
  app.get<{ Params: { orgId: string } }>(
    '/admin/orgs/:orgId/voice-usage',
    { schema: { params: z.object({ orgId: UuidSchema }) } },
    async (request, reply) => {
      requirePlatformAdmin(request);
      const { db } = app.ctx;

      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, request.params.orgId),
        columns: { id: true, name: true, voiceQuota: true },
      });
      if (!org) return reply.notFound();

      const monthStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      );

      const [snapshot, recent] = await Promise.all([
        getUsageSnapshot(db, org.id),
        db
          .select()
          .from(schema.voiceUsage)
          .where(
            and(
              eq(schema.voiceUsage.organizationId, org.id),
              gte(schema.voiceUsage.createdAt, monthStart),
            ),
          )
          .orderBy(desc(schema.voiceUsage.createdAt))
          .limit(50),
      ]);

      const quota = resolveQuota(org.voiceQuota ?? null);

      return reply.send({
        organization: { id: org.id, name: org.name },
        quota,
        snapshot: {
          dailyTurns: snapshot.dailyTurns,
          dailyDollars: +(snapshot.dailyCostCents / 100).toFixed(4),
          monthlyTtsChars: snapshot.monthlyTtsChars,
          monthlyDollars: +(snapshot.monthlyCostCents / 100).toFixed(4),
        },
        recent: recent.map((r) => ({
          id: r.id,
          kind: r.kind,
          units: r.units,
          dollars: +(Number(r.costCents) / 100).toFixed(6),
          createdAt: r.createdAt,
          userId: r.userId,
          assetInstanceId: r.assetInstanceId,
        })),
      });
    },
  );

  // POST /admin/orgs/:orgId/voice-quota — set tier and/or override caps.
  app.post<{ Params: { orgId: string } }>(
    '/admin/orgs/:orgId/voice-quota',
    {
      schema: {
        params: z.object({ orgId: UuidSchema }),
        body: SetQuotaSchema,
      },
    },
    async (request, reply) => {
      requirePlatformAdmin(request);
      const { db } = app.ctx;
      const body = request.body as z.infer<typeof SetQuotaSchema>;

      const existing = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, request.params.orgId),
        columns: { id: true, name: true, voiceQuota: true },
      });
      if (!existing) return reply.notFound();

      // Merge: tier-default → existing override → request override.
      const tier = body.tier;
      const defaults =
        tier === 'custom'
          ? { dailyTurnsCap: null, monthlyTtsCharCap: null, monthlyDollarCap: null, alertDailyDollarThreshold: null }
          : TIER_DEFAULTS[tier];
      const prev = existing.voiceQuota ?? defaults;
      const next = {
        tier,
        dailyTurnsCap:
          body.dailyTurnsCap !== undefined ? body.dailyTurnsCap : prev.dailyTurnsCap ?? defaults.dailyTurnsCap,
        monthlyTtsCharCap:
          body.monthlyTtsCharCap !== undefined ? body.monthlyTtsCharCap : prev.monthlyTtsCharCap ?? defaults.monthlyTtsCharCap,
        monthlyDollarCap:
          body.monthlyDollarCap !== undefined ? body.monthlyDollarCap : prev.monthlyDollarCap ?? defaults.monthlyDollarCap,
        alertDailyDollarThreshold:
          body.alertDailyDollarThreshold !== undefined
            ? body.alertDailyDollarThreshold
            : prev.alertDailyDollarThreshold ?? defaults.alertDailyDollarThreshold,
      };

      await db
        .update(schema.organizations)
        .set({ voiceQuota: next, updatedAt: new Date() })
        .where(eq(schema.organizations.id, request.params.orgId));

      return reply.send({ organization: { id: existing.id, name: existing.name }, quota: next });
    },
  );
}
