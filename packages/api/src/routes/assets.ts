import type { FastifyInstance } from 'fastify';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  schema,
  PM_PLAN_FREQUENCY_DAYS,
  type PmPlanFrequency,
} from '@platform/db';
import {
  AssetHubPayloadSchema,
  ASSET_MODEL_SPEC_KEYS,
  QrCodeStringSchema,
  type AssetModelSpecs,
} from '@platform/shared';
import { computeScheduleStatus, calendarDayDiff } from '../lib/pm-status';
import { recordAudit } from '../lib/audit.js';
import { requireAuthOrScan } from '../middleware/scan-session';

// Two-letter initials from a display name — shown when no logo uploaded.
// "Flow Turn" → "FT", "Dematic" → "DE", "Acme Logistics" → "AL".
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'EH';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export async function registerAssetRoutes(app: FastifyInstance) {
  // Resolve a scanned QR code to the asset hub payload.
  // This is the single hottest endpoint — it fires on every QR scan.
  app.get<{
    Params: { qrCode: string };
    Querystring: { source?: 'qr' | 'direct' | 'blocked' };
  }>(
    '/assets/resolve/:qrCode',
    {
      schema: {
        params: z.object({ qrCode: QrCodeStringSchema }),
        querystring: z.object({
          source: z.enum(['qr', 'direct', 'blocked']).optional(),
        }),
        response: { 200: AssetHubPayloadSchema },
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const { qrCode } = request.params;

      // Authorize first. The endpoint was previously fully open and acted as
      // a customer-base enumeration oracle (any QR string returned full
      // org/site/asset metadata). We require either a signed-in user or a
      // valid scan-session — the PWA's /q/[qrCode] handshake routes call
      // this endpoint *with* the scan-session cookie, so the legitimate
      // flow is unaffected.
      requireAuthOrScan(request);

      const qr = await db.query.qrCodes.findFirst({
        where: and(eq(schema.qrCodes.code, qrCode), eq(schema.qrCodes.active, true)),
      });
      if (!qr || !qr.assetInstanceId) {
        return reply.notFound('Unknown or inactive QR code.');
      }

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, qr.assetInstanceId),
        with: {
          model: { with: { owner: true } },
          site: { with: { organization: true } },
          pinnedContentPackVersion: true,
        },
      });
      if (!instance) return reply.notFound('Asset instance not found.');

      // Cross-tenant access check. The caller must either own a matching
      // scan session (the QR they just scanned), be a member of the asset's
      // owning org, or be a platform admin. Return 404 (not 403) on
      // mismatch so the endpoint doesn't function as an existence oracle.
      const callerOrgId =
        request.auth?.organizationId ?? request.scanSession?.organizationId;
      const targetOrgId = instance.site.organization.id;
      const scanMatches =
        request.scanSession?.assetInstanceId === instance.id;
      const isPlatformAdmin = request.auth?.platformAdmin === true;
      if (!isPlatformAdmin && !scanMatches && callerOrgId !== targetOrgId) {
        // Best-effort org-tree check: if the caller's home org is in the
        // asset-owner's relationship tree (dealer → end-customer, etc.) we
        // allow it via the standard scope helper. For unauthenticated
        // scan-only callers without a matching scan session, refuse.
        if (request.auth) {
          const { getScope } = await import('../middleware/scope');
          const scope = await getScope(request, db);
          if (!scope.all && !scope.orgIds.includes(targetOrgId)) {
            return reply.notFound('Unknown or inactive QR code.');
          }
        } else {
          return reply.notFound('Unknown or inactive QR code.');
        }
      }

      const [docCount, trainingCount, partsCount, openWoCount, fieldCapturesVersionId, pmSummary] =
        await Promise.all([
          // Docs count must mirror what the Library (Docs) tab actually
          // renders, otherwise the Overview tile undercounts/overcounts
          // the destination it links to. Library rules:
          //   - Includes the pinned ContentPack version's documents
          //   - Includes the model's field-captures pack documents
          //   - Excludes kind='structured_procedure' (procedures live in
          //     the Maintenance tab, not the Library)
          // The previous count was a single bare SELECT against the
          // pinned version and included structured_procedure rows, so an
          // asset with 14 procedures + 2 docs showed "16" on Overview
          // and only 2 in Library.
          (async () => {
            const pinned = instance.pinnedContentPackVersionId
              ? await countRows(
                  db,
                  sql`SELECT count(*)::int AS n FROM documents
                      WHERE content_pack_version_id = ${instance.pinnedContentPackVersionId}
                        AND kind != 'structured_procedure'`,
                )
              : 0;
            const field = await countRows(
              db,
              sql`SELECT count(*)::int AS n
                  FROM documents d
                  JOIN content_pack_versions v ON v.id = d.content_pack_version_id
                  JOIN content_packs p ON p.id = v.content_pack_id
                  WHERE p.kind = 'field_captures'
                    AND p.asset_model_id = ${instance.assetModelId}
                    AND d.kind != 'structured_procedure'`,
            );
            return pinned + field;
          })(),
          instance.pinnedContentPackVersionId
            ? countRows(
                db,
                sql`SELECT count(*)::int AS n FROM training_modules
                    WHERE content_pack_version_id = ${instance.pinnedContentPackVersionId}`,
              )
            : Promise.resolve(0),
          countRows(
            db,
            sql`SELECT count(*)::int AS n FROM bom_entries WHERE asset_model_id = ${instance.assetModelId}`,
          ),
          countRows(
            db,
            sql`SELECT count(*)::int AS n FROM work_orders
                WHERE asset_instance_id = ${instance.id}
                  AND status IN ('open','acknowledged','in_progress','blocked')`,
          ),
          // Lookup the field-captures pack's version for this asset model.
          // Lazy-created on first capture; null until then. Schema guarantees
          // at most one field_captures pack per model (partial unique index).
          db
            .execute<{ version_id: string | null }>(
              sql`SELECT cpv.id AS version_id
                  FROM content_packs cp
                  JOIN content_pack_versions cpv ON cpv.content_pack_id = cp.id
                  WHERE cp.kind = 'field_captures'
                    AND cp.asset_model_id = ${instance.assetModelId}
                  ORDER BY cpv.version_number DESC
                  LIMIT 1`,
            )
            .then((rows) => (rows[0]?.version_id ?? null) as string | null),
          // PM summary: count overdue/due/soon for the nameplate badge.
          // Covers BOTH the legacy flat pmSchedules AND the newer pmPlans
          // (which group items into frequency buckets). The Maintenance
          // tab's "Action" card sums both surfaces; the Overview badge
          // must match or techs see "0 PM actions" on Overview and "1
          // Action" on Maintenance for the same asset.
          (async () => {
            const counts = { overdue: 0, due: 0, soon: 0, needsAction: 0 };
            const now = new Date();

            // --- Flat schedule contribution ---
            const schedules = await db.query.pmSchedules.findMany({
              where: and(
                eq(schema.pmSchedules.assetModelId, instance.assetModelId),
                eq(schema.pmSchedules.disabled, false),
              ),
            });
            if (schedules.length > 0) {
              const records = await db.query.pmServiceRecords.findMany({
                where: and(
                  eq(schema.pmServiceRecords.assetInstanceId, instance.id),
                  inArray(
                    schema.pmServiceRecords.pmScheduleId,
                    schedules.map((s) => s.id),
                  ),
                ),
                orderBy: [desc(schema.pmServiceRecords.performedAt)],
              });
              const lastByScheduleId = new Map<string, Date>();
              for (const r of records) {
                if (r.pmScheduleId && !lastByScheduleId.has(r.pmScheduleId)) {
                  lastByScheduleId.set(r.pmScheduleId, r.performedAt);
                }
              }
              for (const s of schedules) {
                const r = computeScheduleStatus({
                  cadenceKind: s.cadenceKind,
                  cadenceValue: s.cadenceValue,
                  graceDays: s.graceDays,
                  scheduleCreatedAt: s.createdAt,
                  instanceInstalledAt: instance.installedAt,
                  lastPerformedAt: lastByScheduleId.get(s.id) ?? null,
                  now,
                  timezone: instance.site.timezone,
                });
                if (r.status === 'overdue') counts.overdue += 1;
                else if (r.status === 'due') counts.due += 1;
                else if (r.status === 'soon') counts.soon += 1;
                if (r.needsAction) counts.needsAction += 1;
              }
            }

            // --- PM plan bucket contribution ---
            // Mirrors computePmPlanStatusForInstance in pm.ts but skips
            // the bucket payload — we only need the per-bucket status to
            // increment counts. Empty draft check-rows (checkText === '')
            // are excluded, matching the full endpoint.
            const plans = await db.query.pmPlans.findMany({
              where: and(
                eq(schema.pmPlans.assetModelId, instance.assetModelId),
                eq(schema.pmPlans.disabled, false),
              ),
            });
            if (plans.length > 0) {
              const planIds = plans.map((p) => p.id);
              const items = await db.query.pmPlanItems.findMany({
                where: inArray(schema.pmPlanItems.planId, planIds),
              });
              const planRecords = await db.query.pmPlanServiceRecords.findMany({
                where: and(
                  eq(schema.pmPlanServiceRecords.assetInstanceId, instance.id),
                  inArray(schema.pmPlanServiceRecords.planId, planIds),
                ),
                orderBy: [desc(schema.pmPlanServiceRecords.performedAt)],
              });
              const lastByKey = new Map<string, Date>();
              for (const r of planRecords) {
                if (!r.planId) continue;
                const k = `${r.planId}:${r.frequency}`;
                if (!lastByKey.has(k)) lastByKey.set(k, r.performedAt);
              }
              for (const p of plans) {
                // Items grouped by frequency for THIS plan, ignoring
                // empty drafts so a checklist with all-blank rows
                // doesn't show as a real bucket.
                const planItems = items.filter(
                  (it) => it.planId === p.id && it.checkText.trim().length > 0,
                );
                const byFreq = new Map<PmPlanFrequency, number>();
                for (const it of planItems) {
                  const f = it.frequency as PmPlanFrequency;
                  byFreq.set(f, (byFreq.get(f) ?? 0) + 1);
                }
                for (const [f, n] of byFreq.entries()) {
                  if (n === 0) continue;
                  const cadenceDays = PM_PLAN_FREQUENCY_DAYS[f];
                  const last = lastByKey.get(`${p.id}:${f}`);
                  const anchor = last ?? instance.installedAt ?? p.createdAt;
                  const daysSinceAnchor = calendarDayDiff(
                    anchor,
                    now,
                    instance.site.timezone,
                  );
                  const daysUntilDue = cadenceDays - daysSinceAnchor;
                  const status =
                    daysUntilDue < 0
                      ? 'overdue'
                      : daysUntilDue === 0
                        ? 'due'
                        : daysUntilDue <= 7
                          ? 'soon'
                          : 'upcoming';
                  if (status === 'overdue') counts.overdue += 1;
                  else if (status === 'due') counts.due += 1;
                  else if (status === 'soon') counts.soon += 1;
                  if (status === 'overdue' || status === 'due') counts.needsAction += 1;
                }
              }
            }

            return counts;
          })(),
        ]);

      const oem = instance.model.owner;
      const brandDisplayName = oem.displayNameOverride ?? oem.name;
      const { storage } = app.ctx;
      const modelImageUrl = instance.model.imageStorageKey
        ? storage.publicUrl(instance.model.imageStorageKey)
        : null;

      const instanceImageUrl = instance.imageStorageKey
        ? storage.publicUrl(instance.imageStorageKey)
        : null;

      // Project the model's spec jsonb down to the four typed keys the
      // PWA renders. Anything else stored there (legacy, future-proofing)
      // is intentionally dropped so the hub payload schema stays tight.
      const rawSpecs = (instance.model.specifications ?? {}) as Record<string, unknown>;
      const specifications: AssetModelSpecs = {};
      for (const key of ASSET_MODEL_SPEC_KEYS) {
        const v = rawSpecs[key];
        if (typeof v === 'string' && v.trim().length > 0) specifications[key] = v;
      }
      const rawMeta = (instance.metadata ?? {}) as Record<string, unknown>;
      const location =
        typeof rawMeta.location === 'string' && rawMeta.location.trim().length > 0
          ? rawMeta.location
          : null;
      const epn =
        typeof rawMeta.epn === 'string' && rawMeta.epn.trim().length > 0
          ? rawMeta.epn
          : null;

      const payload = AssetHubPayloadSchema.parse({
        assetInstance: {
          id: instance.id,
          serialNumber: instance.serialNumber,
          installedAt: instance.installedAt?.toISOString() ?? null,
          imageUrl: instanceImageUrl,
          location,
          epn,
        },
        assetModel: {
          id: instance.model.id,
          modelCode: instance.model.modelCode,
          displayName: instance.model.displayName,
          category: instance.model.category,
          description: instance.model.description,
          imageUrl: modelImageUrl,
          specifications,
        },
        site: {
          id: instance.site.id,
          name: instance.site.name,
          timezone: instance.site.timezone,
        },
        organization: {
          id: instance.site.organization.id,
          name: instance.site.organization.name,
          requireScanAccess: instance.site.organization.requireScanAccess,
        },
        pinnedContentPackVersion: instance.pinnedContentPackVersion
          ? {
              id: instance.pinnedContentPackVersion.id,
              versionNumber: instance.pinnedContentPackVersion.versionNumber,
              versionLabel: instance.pinnedContentPackVersion.versionLabel,
              publishedAt:
                instance.pinnedContentPackVersion.publishedAt?.toISOString() ?? null,
            }
          : null,
        fieldCapturesVersionId,
        tabs: {
          docs: { count: docCount },
          training: { count: trainingCount },
          parts: { count: partsCount },
          openWorkOrders: { count: openWoCount },
          pm: pmSummary,
        },
        brand: {
          displayName: brandDisplayName,
          primary: oem.brandPrimary,
          onPrimary: oem.brandOnPrimary,
          logoUrl: oem.logoStorageKey ? storage.publicUrl(oem.logoStorageKey) : null,
          initials: initials(brandDisplayName),
        },
      });

      // Append an audit trail. Event type depends on source so security-
      // sensitive customers can distinguish real QR scans from URL shares
      // from scan-gate denials.
      const source = request.query.source ?? 'direct';
      const eventType =
        source === 'qr'
          ? 'qr.scan'
          : source === 'blocked'
          ? 'qr.scan.blocked'
          : 'asset.hub.viewed';
      await recordAudit(db, request, {
        organizationId: instance.site.organization.id,
        eventType,
        targetType: 'asset_instance',
        targetId: instance.id,
        payload: { qrCode, source },
      });

      return payload;
    },
  );
}

async function countRows(db: any, query: any): Promise<number> {
  const rows = (await db.execute(query)) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
