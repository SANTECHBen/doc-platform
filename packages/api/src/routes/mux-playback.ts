// Mux signed-playback token mint. Public Mux playback IDs are perpetual,
// off-platform stream tokens — anyone who scrapes the ID can stream the
// video forever. Switching to signed playback (env.MUX_PLAYBACK_POLICY)
// makes the ID alone insufficient; the player must also present a JWT
// signed by our Mux signing key.
//
// This route is the only path a client can obtain a token. We require
// auth + scope before minting one, so a stolen playback ID is useless to
// anyone outside the asset's owning org tree.

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { requireAuthOrScan, getEffectiveOrgScope } from '../middleware/scan-session.js';

const BodySchema = z.object({
  playbackId: z.string().min(8).max(128).regex(/^[A-Za-z0-9]+$/),
  /** Mux audience: 'v' = video stream (default), 't' = thumbnail still,
   *  'g' = animated gif, 's' = storyboard timeline. */
  audience: z.enum(['v', 't', 'g', 's']).default('v'),
});

export async function registerMuxPlaybackRoutes(app: FastifyInstance) {
  app.post<{ Body: z.infer<typeof BodySchema> }>(
    '/media/mux-playback-token',
    { schema: { body: BodySchema } },
    async (request, reply) => {
      const { db, mux } = app.ctx;
      if (!mux) return reply.serviceUnavailable('Mux not configured');

      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      // Find the playback id's owning row. We check three tables:
      // procedure_steps.media[], procedure_draft_runs, agent_run_files —
      // any model that stores Mux assets must expose an owning org so
      // this check can succeed. Failing all of them, we refuse to mint.
      const owningOrg = await resolveMuxPlaybackOwningOrg(
        db,
        request.body.playbackId,
      );
      if (!owningOrg) return reply.notFound('Playback id not found');
      if (!scope.all && !scope.orgIds.includes(owningOrg)) {
        return reply.notFound('Playback id not found');
      }

      const token = mux.signPlaybackToken({
        playbackId: request.body.playbackId,
        audience: request.body.audience,
        ttlSeconds: 3600, // 1h
      });
      if (token === null) {
        // playbackPolicy is 'public' — the client doesn't need a token.
        return reply.send({
          policy: 'public' as const,
          playbackId: request.body.playbackId,
        });
      }
      return reply.send({
        policy: 'signed' as const,
        playbackId: request.body.playbackId,
        token,
        expiresIn: 3600,
      });
    },
  );
}

/**
 * Find the org that owns a Mux playback id. Best-effort lookup across
 * the tables we know about. Returns null when no owner can be found —
 * the caller treats that as 404.
 *
 * The check matches both `mux_playback_id` and `playback_id` columns to
 * cover the schema variants in use across the codebase.
 */
async function resolveMuxPlaybackOwningOrg(
  db: import('@platform/db').Database,
  playbackId: string,
): Promise<string | null> {
  // 1. procedure_draft_runs (PWA video walkthroughs, agent ingest).
  const draft = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.muxPlaybackId, playbackId),
    columns: { ownerOrganizationId: true },
  });
  if (draft) return draft.ownerOrganizationId;

  // 2. agent_run_files — Mux-uploaded onboarding media. Cross-ref to the
  // run for the org. The column on the table is `streamPlaybackId`.
  const arf = await db.query.agentRunFiles.findFirst({
    where: eq(schema.agentRunFiles.streamPlaybackId, playbackId),
    with: { run: { columns: { targetOrganizationId: true } } },
  });
  if (arf?.run?.targetOrganizationId) return arf.run.targetOrganizationId;

  // 3. procedure_steps.media — JSONB. SQL search via JSON path.
  const stepRow = (await db.execute(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    (await import('drizzle-orm')).sql`
      SELECT cp.owner_organization_id
        FROM procedure_steps ps
        JOIN documents d ON d.id = ps.document_id
        JOIN content_pack_versions v ON v.id = d.content_pack_version_id
        JOIN content_packs cp ON cp.id = v.content_pack_id
       WHERE ps.media @> ${JSON.stringify([{ playbackId }])}::jsonb
         OR ps.media @> ${JSON.stringify([{ muxPlaybackId: playbackId }])}::jsonb
       LIMIT 1
    `,
  )) as unknown as Array<{ owner_organization_id: string }>;
  if (stepRow[0]) return stepRow[0].owner_organization_id;

  return null;
}
