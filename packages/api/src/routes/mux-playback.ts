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
import { muxClipUrlFor } from '../lib/mux.js';

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

  // -------------------------------------------------------------------------
  // POST /media/mux-clip-url — mint a clip-bounded HLS URL
  //
  // The admin draft editor and the published-step clip-range editor both
  // need an HLS URL representing JUST [startMs..endMs] of a Mux asset so
  // the reviewer can audition the cut with audio. Server-minting (rather
  // than building the URL in the browser) is required for signed-playback
  // deployments — the clip bounds have to ride inside the JWT or Mux
  // rejects the URL. Scope-checked the same way as the token mint above:
  // the playback id must belong to an org the caller can see.
  // -------------------------------------------------------------------------
  app.post<{
    Body: { playbackId: string; startMs: number; endMs: number };
  }>(
    '/media/mux-clip-url',
    {
      schema: {
        body: z.object({
          playbackId: z.string().min(8).max(128).regex(/^[A-Za-z0-9]+$/),
          // 24h max — well above any plausible source video length while
          // still bounding the validation surface.
          startMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
          endMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
        }),
      },
    },
    async (request, reply) => {
      const { db, mux } = app.ctx;
      if (!mux) return reply.serviceUnavailable('Mux not configured');
      const { playbackId, startMs, endMs } = request.body;
      if (endMs <= startMs) {
        return reply.badRequest('endMs must be greater than startMs');
      }

      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();
      const owningOrg = await resolveMuxPlaybackOwningOrg(db, playbackId);
      if (!owningOrg) return reply.notFound('Playback id not found');
      if (!scope.all && !scope.orgIds.includes(owningOrg)) {
        return reply.notFound('Playback id not found');
      }

      const url = muxClipUrlFor(mux, { playbackId, startMs, endMs });
      return reply.send({ url, expiresIn: 3600 });
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
