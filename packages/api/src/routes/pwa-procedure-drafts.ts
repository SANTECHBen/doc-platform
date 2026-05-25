// PWA-facing route for video walkthrough submissions.
//
// A field tech records a walkthrough on their device and submits it
// through the PWA. We:
//   1. Resolve the org from the asset they were working on.
//   2. Pick a target content pack version (an existing draft or the
//      latest published) for the asset model. If none exists, refuse
//      the submission (the admin needs to set up the pack first).
//   3. Create a procedure_draft_runs row with pwa_submitted=true so the
//      pipeline pauses at pending_admin_decision instead of auto-running
//      the LLM.
//   4. Mint a Mux Direct Upload URL and return it.
//
// The PWA PUTs the video bytes directly to Mux; we never proxy the file
// through the API.

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import { makeDraftPassthrough } from '../services/draft-pipeline.js';

const SubmitBody = z.object({
  assetInstanceId: UuidSchema,
  proposedTitle: z.string().min(1).max(200),
  notes: z.string().max(1000).optional(),
  /** Tech-asserted orientation. When present, the executor uses this
   *  for the per-step video_clip aspect instead of trusting Mux's
   *  auto-detection. Handles the case where the recorded pixels are
   *  sideways but the user knows they filmed in portrait. */
  orientationOverride: z.enum(['portrait', 'landscape']).optional(),
  /** Tech-picked category — drives the Maintenance bucket the promoted
   *  procedure ends up under AND lets the drafter executor pre-select
   *  a matching template. Collected by the shared ProcedureIntake
   *  screens on the PWA. Optional for back-compat with older clients
   *  that may not send it. */
  procedureCategory: z
    .enum(['preventive_maintenance', 'removal_replacement', 'troubleshooting', 'walkthrough'])
    .optional(),
});

export async function registerPwaProcedureDrafts(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /pwa/procedure-drafts — start a PWA-submitted draft + mint upload
  // -------------------------------------------------------------------------
  app.post<{ Body: z.infer<typeof SubmitBody> }>(
    '/pwa/procedure-drafts',
    { schema: { body: SubmitBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      if (!app.ctx.mux) {
        return reply.serviceUnavailable('Mux not configured');
      }

      // Resolve the asset → asset model → pack so we can pick a target
      // content pack version. PWA submissions land into the pack the
      // asset is pinned to (preferred) or the latest published pack for
      // the asset's model (fallback).
      const asset = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.body.assetInstanceId),
        with: { model: true, site: { columns: { organizationId: true } } },
      });
      if (!asset) return reply.notFound('asset instance not found');
      // Scope check: the asset's owning org must be in the caller's scope.
      // Without this any authenticated user could pass any asset UUID and
      // create a draft attributed to that asset's org — and burn Mux
      // ingest cost on the victim. requireOrgInScope returns 404 (not
      // 403) so the endpoint isn't an existence oracle.
      const scope = await getScope(request, db);
      requireOrgInScope(scope, asset.site.organizationId);

      // Prefer the asset's pinned version; otherwise the latest published
      // version of any pack owned by the asset model.
      let targetVersionId: string | null = asset.pinnedContentPackVersionId;
      let ownerOrganizationId: string | null = null;

      if (targetVersionId) {
        const pinned = await db.query.contentPackVersions.findFirst({
          where: eq(schema.contentPackVersions.id, targetVersionId),
          with: { pack: true },
        });
        if (pinned?.pack) ownerOrganizationId = pinned.pack.ownerOrganizationId;
      }
      if (!targetVersionId || !ownerOrganizationId) {
        // Walk asset model → its packs → latest published version.
        const packs = await db.query.contentPacks.findMany({
          where: eq(schema.contentPacks.assetModelId, asset.assetModelId),
        });
        if (packs.length === 0) {
          return reply.badRequest(
            'No content pack exists for this asset model yet. Ask an admin to set one up first.',
          );
        }
        // Pick the pack owned by the asset model's owner, then its
        // latest published version. Falls back to any published version
        // owned by a pack on this asset model.
        const versions = await db.query.contentPackVersions.findMany({
          where: and(
            eq(schema.contentPackVersions.status, 'published'),
          ),
          orderBy: [desc(schema.contentPackVersions.versionNumber)],
        });
        const inScope = versions.find((v) =>
          packs.some((p) => p.id === v.contentPackId),
        );
        if (!inScope) {
          return reply.badRequest(
            'No published content pack version is available for this asset. Ask an admin to publish one.',
          );
        }
        targetVersionId = inScope.id;
        const owningPack = packs.find((p) => p.id === inScope.contentPackId);
        ownerOrganizationId = owningPack?.ownerOrganizationId ?? null;
      }
      if (!ownerOrganizationId) {
        return reply.internalServerError(
          'failed to resolve owner organization for PWA submission',
        );
      }

      const [run] = await db
        .insert(schema.procedureDraftRuns)
        .values({
          ownerOrganizationId,
          targetContentPackVersionId: targetVersionId,
          proposedTitle: request.body.proposedTitle,
          status: 'uploading',
          pwaSubmitted: true,
          submittedByUserId: auth.userId,
          submittedFromAssetInstanceId: asset.id,
          submissionNotes: request.body.notes ?? null,
          // Stash the tech's orientation hint into the existing
          // sourceVideoOrientation column. The Mux webhook will only
          // overwrite it if Mux reports a *different* orientation; the
          // executor reads this column when building each step's clip
          // metadata, so the runner ends up framing the clip the way
          // the tech said it should be framed.
          sourceVideoOrientation: request.body.orientationOverride ?? null,
          // Tech-picked category from the intake screens. Surfaces on
          // the admin reviewer's UI and gates which executor template
          // the drafter uses.
          procedureCategory: request.body.procedureCategory ?? null,
          createdByUserId: auth.userId,
        })
        .returning();
      if (!run) return reply.internalServerError('Failed to create draft');

      const upload = await app.ctx.mux.createDirectUpload({
        passthrough: makeDraftPassthrough(run.id),
      });
      await db
        .update(schema.procedureDraftRuns)
        .set({ muxUploadId: upload.uploadId, updatedAt: new Date() })
        .where(eq(schema.procedureDraftRuns.id, run.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_draft.pwa_submitted',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {
          proposedTitle: run.proposedTitle,
          assetInstanceId: asset.id,
          notes: request.body.notes ?? null,
          procedureCategory: request.body.procedureCategory ?? null,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.code(201).send({
        runId: run.id,
        uploadId: upload.uploadId,
        uploadUrl: upload.uploadUrl,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /pwa/procedure-drafts/mine — list the tech's own submissions
  //
  // Lets the tech check whether their submission was processed (and
  // ultimately accepted into a real procedure). Scoped to their own
  // userId; admin-initiated drafts never appear here.
  // -------------------------------------------------------------------------
  app.get('/pwa/procedure-drafts/mine', async (request, reply) => {
    const { db } = app.ctx;
    const auth = requireAuth(request);
    const rows = await db.query.procedureDraftRuns.findMany({
      where: and(
        eq(schema.procedureDraftRuns.submittedByUserId, auth.userId),
        eq(schema.procedureDraftRuns.pwaSubmitted, true),
      ),
      orderBy: [desc(schema.procedureDraftRuns.createdAt)],
      limit: 50,
    });
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        proposedTitle: r.proposedTitle,
        status: r.status,
        targetDocumentId: r.targetDocumentId,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    );
  });
}
