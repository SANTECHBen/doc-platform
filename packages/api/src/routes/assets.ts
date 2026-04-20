import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { AssetHubPayloadSchema, QrCodeStringSchema } from '@platform/shared';

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

      const [docCount, trainingCount, partsCount, openWoCount] = await Promise.all([
        instance.pinnedContentPackVersionId
          ? countRows(
              db,
              sql`SELECT count(*)::int AS n FROM documents
                  WHERE content_pack_version_id = ${instance.pinnedContentPackVersionId}`,
            )
          : Promise.resolve(0),
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
      ]);

      const oem = instance.model.owner;
      const brandDisplayName = oem.displayNameOverride ?? oem.name;
      const { storage } = app.ctx;
      const modelImageUrl = instance.model.imageStorageKey
        ? storage.publicUrl(instance.model.imageStorageKey)
        : null;

      const payload = AssetHubPayloadSchema.parse({
        assetInstance: {
          id: instance.id,
          serialNumber: instance.serialNumber,
          installedAt: instance.installedAt?.toISOString() ?? null,
        },
        assetModel: {
          id: instance.model.id,
          modelCode: instance.model.modelCode,
          displayName: instance.model.displayName,
          category: instance.model.category,
          description: instance.model.description,
          imageUrl: modelImageUrl,
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
        tabs: {
          docs: { count: docCount },
          training: { count: trainingCount },
          parts: { count: partsCount },
          openWorkOrders: { count: openWoCount },
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
      await db.insert(schema.auditEvents).values({
        organizationId: instance.site.organization.id,
        actorUserId: request.auth?.userId ?? null,
        eventType,
        targetType: 'asset_instance',
        targetId: instance.id,
        payload: { qrCode, source },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return payload;
    },
  );
}

async function countRows(db: any, query: any): Promise<number> {
  const rows = (await db.execute(query)) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
