import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getScope } from '../middleware/scope';

// Beta analytics endpoint. Returns aggregate metrics over a configurable
// time window, optionally filtered to a single tenant org. Powers the
// SANTECH-internal /analytics page in the admin app — the v1 dashboard
// for measuring beta success metrics (activation, scan volume, work
// orders, procedure completion, feedback rate).
//
// Scope-aware: platform admins see all orgs unless they pass orgId;
// non-platform admins only see their org scope regardless.

const QuerySchema = z.object({
  // Window in days back from now. Bounded to keep queries fast.
  days: z.coerce.number().int().min(1).max(365).default(30),
  // Optional single-org filter (subject to scope).
  orgId: z.string().uuid().optional(),
});

interface DailyBucket {
  day: string; // YYYY-MM-DD
  count: number;
}

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get(
    '/admin/analytics',
    {
      schema: { querystring: QuerySchema },
    },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const q = request.query as z.infer<typeof QuerySchema>;
      const sinceMs = Date.now() - q.days * 24 * 60 * 60 * 1000;
      // postgres@3.4.x crashes when a Date is passed as a parameter to
      // db.execute(sql`...${date}...`) — its Bind step calls
      // Buffer.byteLength(date) without first coercing to string. Pass
      // the ISO string explicitly; postgres coerces text → timestamptz
      // on comparison, so the WHERE semantics are unchanged.
      const since = new Date(sinceMs).toISOString();

      // Compute the effective org filter. Platform admins with no orgId
      // get all orgs; non-platform admins are forced to their scope.
      const orgIds = q.orgId
        ? scope.all
          ? [q.orgId]
          : scope.orgIds.filter((id) => id === q.orgId)
        : scope.all
        ? null
        : scope.orgIds;

      if (orgIds && orgIds.length === 0) {
        return emptyResponse(q.days);
      }

      const orgFilter = orgIds === null ? sql`` : sql`AND organization_id = ANY(${orgIds}::uuid[])`;
      const orgFilterAny = (col: string) =>
        orgIds === null ? sql`` : sql`AND ${sql.raw(col)} = ANY(${orgIds}::uuid[])`;

      // 1) Audit-log derived counts (scans, hub views, blocked, work orders, procedures).
      const auditCounts = (await db.execute(sql`
        SELECT event_type, count(*)::int AS n
        FROM audit_events
        WHERE occurred_at >= ${since}
          ${orgFilter}
        GROUP BY event_type
      `)) as unknown as Array<{ event_type: string; n: number }>;

      const counts = Object.fromEntries(
        auditCounts.map((r) => [r.event_type, Number(r.n)]),
      );

      // 2) Distinct active assets — assets that received a qr.scan or asset.hub.viewed.
      const activeAssetsRow = (await db.execute(sql`
        SELECT count(DISTINCT target_id)::int AS n
        FROM audit_events
        WHERE occurred_at >= ${since}
          AND target_type = 'asset_instance'
          AND event_type IN ('qr.scan', 'asset.hub.viewed')
          ${orgFilter}
      `)) as unknown as Array<{ n: number }>;

      // 3) Feedback submissions (separate table — not in audit log).
      const feedbackRow = (await db.execute(sql`
        SELECT count(*)::int AS n
        FROM feedback
        WHERE submitted_at >= ${since}
          ${orgIds === null ? sql`` : sql`AND org_id = ANY(${orgIds}::uuid[])`}
      `)) as unknown as Array<{ n: number }>;

      // 4) AI chat messages (rough proxy via audit log if instrumented;
      // otherwise return null so the dashboard renders "—" rather than 0).
      const aiMessages = counts['ai.chat.message'] ?? null;

      // 5) Daily breakdown of scans for sparkline-friendly response.
      const dailyScans = (await db.execute(sql`
        SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               count(*)::int AS n
        FROM audit_events
        WHERE occurred_at >= ${since}
          AND event_type IN ('qr.scan', 'asset.hub.viewed')
          ${orgFilter}
        GROUP BY day
        ORDER BY day
      `)) as unknown as Array<{ day: string; n: number }>;

      const scansSeries: DailyBucket[] = fillDays(q.days, dailyScans);

      return {
        windowDays: q.days,
        scope: {
          orgIds: orgIds ?? 'all',
          orgIdRequested: q.orgId ?? null,
        },
        scans: counts['qr.scan'] ?? 0,
        hubViews: counts['asset.hub.viewed'] ?? 0,
        blockedScans: counts['qr.scan.blocked'] ?? 0,
        activeAssets: activeAssetsRow[0]?.n ?? 0,
        workOrdersOpened: counts['work_order.opened'] ?? 0,
        workOrdersStatusChanges: counts['work_order.status_changed'] ?? 0,
        procedureRunsStarted: counts['procedure_run.started'] ?? 0,
        procedureRunsFinished: counts['procedure_run.finished'] ?? 0,
        procedureRunsAbandoned: counts['procedure_run.abandoned'] ?? 0,
        contentPacksPublished: counts['content_pack.published'] ?? 0,
        sectionsCreated: counts['document_section.created'] ?? 0,
        aiChatMessages: aiMessages,
        feedbackSubmissions: feedbackRow[0]?.n ?? 0,
        scansByDay: scansSeries,
      };
    },
  );
}

function emptyResponse(days: number) {
  return {
    windowDays: days,
    scope: { orgIds: [] as string[], orgIdRequested: null as string | null },
    scans: 0,
    hubViews: 0,
    blockedScans: 0,
    activeAssets: 0,
    workOrdersOpened: 0,
    workOrdersStatusChanges: 0,
    procedureRunsStarted: 0,
    procedureRunsFinished: 0,
    procedureRunsAbandoned: 0,
    contentPacksPublished: 0,
    sectionsCreated: 0,
    aiChatMessages: null as number | null,
    feedbackSubmissions: 0,
    scansByDay: fillDays(days, []),
  };
}

function fillDays(days: number, rows: Array<{ day: string; n: number }>): DailyBucket[] {
  const map = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const out: DailyBucket[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) ?? 0 });
  }
  return out;
}
