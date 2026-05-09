import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuthOrScan, getEffectiveOrgScope } from '../middleware/scan-session';

// AI-first scan landing.
//
// GET /ai/preflight/:assetInstanceId
// → Everything the voice greeter needs to speak a useful intro the moment the
//   tech scans, before they say a word:
//     • open work orders (count + recent titles)
//     • work orders resolved in the last 30 days (recurrence signal)
//     • doc updates since 30 days ago (new sections / new docs)
//     • a one-line natural-language `greeting` ready to pipe into TTS
//
// Output is intentionally compact so it can fit in the 500-byte cellular
// payload before TTS even begins playing.

const Params = z.object({ assetInstanceId: UuidSchema });

const RECENT_DAYS = 30;
const RECENT_WO_LIMIT = 3;
const RECENT_DOC_LIMIT = 5;

interface PreflightBrief {
  assetModelDisplayName: string;
  serialNumber: string;
  pinnedVersionLabel: string | null;
  openWorkOrders: { count: number; samples: Array<{ title: string; severity: string }> };
  recentResolved: { count: number; commonTitle: string | null };
  recentDocUpdates: Array<{ title: string; kind: string; at: string }>;
  greeting: string;
}

export async function registerPreflightRoutes(app: FastifyInstance) {
  app.get<{ Params: { assetInstanceId: string } }>(
    '/ai/preflight/:assetInstanceId',
    { schema: { params: Params } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.assetInstanceId),
        with: { model: true, site: true, pinnedContentPackVersion: true },
      });
      if (!instance) return reply.notFound();
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.notFound();
      }

      const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);

      // Three parallel cheap queries — the whole preflight should beat TTS
      // first-byte latency (~200 ms).
      const [openRows, resolvedRows, recentSections] = await Promise.all([
        db
          .select({
            id: schema.workOrders.id,
            title: schema.workOrders.title,
            severity: schema.workOrders.severity,
            openedAt: schema.workOrders.openedAt,
          })
          .from(schema.workOrders)
          .where(
            and(
              eq(schema.workOrders.assetInstanceId, instance.id),
              inArray(schema.workOrders.status, [
                'open',
                'acknowledged',
                'in_progress',
                'blocked',
              ]),
            ),
          )
          .orderBy(desc(schema.workOrders.openedAt))
          .limit(RECENT_WO_LIMIT),
        db
          .select({
            title: schema.workOrders.title,
            resolvedAt: schema.workOrders.resolvedAt,
          })
          .from(schema.workOrders)
          .where(
            and(
              eq(schema.workOrders.assetInstanceId, instance.id),
              inArray(schema.workOrders.status, ['resolved', 'closed']),
              gte(schema.workOrders.resolvedAt, since),
            ),
          ),
        instance.pinnedContentPackVersionId
          ? db.execute<{
              title: string;
              kind: string;
              updated_at: string;
            }>(
              sql`SELECT d.title AS title,
                         d.kind::text AS kind,
                         GREATEST(d.created_at, COALESCE(MAX(s.updated_at), d.created_at)) AS updated_at
                  FROM documents d
                  LEFT JOIN document_sections s ON s.document_id = d.id
                  WHERE d.content_pack_version_id = ${instance.pinnedContentPackVersionId}
                  GROUP BY d.id, d.title, d.kind, d.created_at
                  HAVING GREATEST(d.created_at, COALESCE(MAX(s.updated_at), d.created_at)) >= ${since.toISOString()}
                  ORDER BY updated_at DESC
                  LIMIT ${RECENT_DOC_LIMIT}`,
            )
          : Promise.resolve([] as Array<{ title: string; kind: string; updated_at: string }>),
      ]);

      const openCount = openRows.length;
      const resolvedCount = resolvedRows.length;

      // "Common title" is the most-frequent resolved-WO title — a soft signal
      // that this asset has a recurring problem worth surfacing in the voice
      // intro ("two recurrences of E-217 in the last month").
      const commonTitle = pickMode(resolvedRows.map((r) => r.title));

      const recentDocUpdates = recentSections.map((r) => ({
        title: r.title,
        kind: r.kind,
        at: typeof r.updated_at === 'string'
          ? r.updated_at
          : new Date(r.updated_at as unknown as Date).toISOString(),
      }));

      const greeting = composeGreeting({
        modelName: instance.model.displayName,
        serial: instance.serialNumber,
        openCount,
        recentResolvedCount: resolvedCount,
        commonTitle,
        docUpdateCount: recentDocUpdates.length,
      });

      const brief: PreflightBrief = {
        assetModelDisplayName: instance.model.displayName,
        serialNumber: instance.serialNumber,
        pinnedVersionLabel: instance.pinnedContentPackVersion?.versionLabel ?? null,
        openWorkOrders: {
          count: openCount,
          samples: openRows.map((r) => ({ title: r.title, severity: r.severity })),
        },
        recentResolved: { count: resolvedCount, commonTitle },
        recentDocUpdates,
        greeting,
      };
      return reply.send(brief);
    },
  );
}

function pickMode(values: string[]): string | null {
  if (values.length < 2) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

// Compose a one-sentence greeting. Kept short and friendly — the tech
// scanned a QR and is standing in front of the equipment; they don't need
// a status report read aloud, they need an opening to ask their question.
//
// Contextual signals (open work orders, recurring fixes, recent doc
// updates) are still returned in the brief payload so the UI can surface
// them visually if/when desired — they're just no longer in the spoken
// greeting.
function composeGreeting(input: {
  modelName: string;
  serial: string;
  openCount: number;
  recentResolvedCount: number;
  commonTitle: string | null;
  docUpdateCount: number;
}): string {
  // Strip "the" duplication ("the IntelliSort HDS" reads fine; "the the
  // CONVEYOR" wouldn't). Light cleanup only.
  const name = input.modelName.replace(/^the\s+/i, '').trim();
  return `How can I help you with the ${name}?`;
}
