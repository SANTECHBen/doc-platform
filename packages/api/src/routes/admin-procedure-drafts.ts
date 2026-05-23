// Admin routes for the AI video-walkthrough drafter.
//
// Surface:
//   POST   /admin/procedure-drafts                       (create + mint Mux upload)
//   GET    /admin/procedure-drafts                       (list)
//   GET    /admin/procedure-drafts/:id                   (full state)
//   PATCH  /admin/procedure-drafts/:id/proposal          (optimistic edit)
//   POST   /admin/procedure-drafts/:id/execute           (kick executor)
//   POST   /admin/procedure-drafts/:id/cancel            (best-effort abort)
//   GET    /admin/procedure-drafts/:id/events?token=...  (SSE)

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { z } from 'zod';
import {
  DraftProposalTreeSchema,
  type DraftProposalTree,
} from '@platform/ai';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import { startSse } from '../lib/sse.js';
import { agentBus, runChannel } from '../lib/agent-bus.js';
import {
  makeDraftPassthrough,
  onDraftMuxAssetCreated,
  onDraftMuxAssetReady,
  onDraftMuxTrackReady,
  onDraftMuxErrored,
  parseDraftPassthrough,
  runDrafterExecution,
} from '../services/draft-pipeline.js';

const CreateBody = z.object({
  proposedTitle: z.string().min(1).max(200),
  targetContentPackVersionId: UuidSchema,
  ownerOrganizationId: UuidSchema,
});

const ListQuery = z.object({
  ownerOrganizationId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ProposalPatchBody = z.object({
  version: z.number().int().positive(),
  content: DraftProposalTreeSchema,
});

// In-process registry of AbortControllers so /cancel can interrupt a
// running execution started by /execute. Keyed by executionId; cleared
// when the execution finishes. Best-effort — a fresh process boot loses
// it, but executions persist their cancelled status either way.
const executionAborts = new Map<string, AbortController>();

function requireDraftAccess(
  run: typeof schema.procedureDraftRuns.$inferSelect,
  scope: { all: boolean; orgIds: string[] },
): void {
  requireOrgInScope(scope, run.ownerOrganizationId);
}

async function loadRun(
  db: Database,
  runId: string,
): Promise<typeof schema.procedureDraftRuns.$inferSelect | null> {
  const r = await db.query.procedureDraftRuns.findFirst({
    where: eq(schema.procedureDraftRuns.id, runId),
  });
  return r ?? null;
}

function runToDTO(r: typeof schema.procedureDraftRuns.$inferSelect) {
  return {
    id: r.id,
    ownerOrganizationId: r.ownerOrganizationId,
    targetContentPackVersionId: r.targetContentPackVersionId,
    targetDocumentId: r.targetDocumentId,
    proposedTitle: r.proposedTitle,
    status: r.status,
    muxUploadId: r.muxUploadId,
    muxAssetId: r.muxAssetId,
    muxPlaybackId: r.muxPlaybackId,
    sourceVideoDurationMs: r.sourceVideoDurationMs,
    sourceVideoSizeBytes: r.sourceVideoSizeBytes,
    transcriptSource: r.transcriptSource,
    hasTranscript: !!r.sourceTranscript,
    hasStoryboard: !!r.storyboardVttUrl,
    error: r.error,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function proposalToDTO(p: typeof schema.procedureDraftProposals.$inferSelect) {
  return {
    id: p.id,
    runId: p.runId,
    version: p.version,
    content: p.content as DraftProposalTree,
    summary: p.summary,
    modelUsed: p.modelUsed,
    tokenUsage: p.tokenUsage,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function registerAdminProcedureDrafts(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /admin/procedure-drafts — create + mint Mux Direct Upload
  // -------------------------------------------------------------------------
  app.post<{ Body: z.infer<typeof CreateBody> }>(
    '/admin/procedure-drafts',
    { schema: { body: CreateBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const body = request.body;
      requireOrgInScope(scope, body.ownerOrganizationId);

      if (!app.ctx.mux) {
        return reply.serviceUnavailable('Mux not configured (AGENT_ENABLED=1 + MUX_* required)');
      }

      // Verify the target content pack version is in scope (its pack's
      // ownerOrganizationId must match the body).
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, body.targetContentPackVersionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound('content_pack_version not found');
      if (version.pack.ownerOrganizationId !== body.ownerOrganizationId) {
        return reply.badRequest(
          'ownerOrganizationId does not match the content pack version owner',
        );
      }

      const [run] = await db
        .insert(schema.procedureDraftRuns)
        .values({
          ownerOrganizationId: body.ownerOrganizationId,
          targetContentPackVersionId: body.targetContentPackVersionId,
          proposedTitle: body.proposedTitle,
          status: 'uploading',
          createdByUserId: auth.userId,
        })
        .returning();
      if (!run) return reply.internalServerError('Failed to create draft run');

      // Mint Mux upload with passthrough = 'draft:<runId>' so the webhook
      // discriminator routes lifecycle events to draft-pipeline.ts.
      const upload = await app.ctx.mux.createDirectUpload({
        passthrough: makeDraftPassthrough(run.id),
      });
      await db
        .update(schema.procedureDraftRuns)
        .set({ muxUploadId: upload.uploadId, updatedAt: new Date() })
        .where(eq(schema.procedureDraftRuns.id, run.id));

      await db.insert(schema.auditEvents).values({
        organizationId: body.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_draft.created',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {
          proposedTitle: body.proposedTitle,
          targetContentPackVersionId: body.targetContentPackVersionId,
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
  // GET /admin/procedure-drafts — list, filterable by org
  // -------------------------------------------------------------------------
  app.get<{ Querystring: z.infer<typeof ListQuery> }>(
    '/admin/procedure-drafts',
    { schema: { querystring: ListQuery } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      if (request.query.ownerOrganizationId) {
        requireOrgInScope(scope, request.query.ownerOrganizationId);
      }
      const filter = request.query.ownerOrganizationId
        ? eq(schema.procedureDraftRuns.ownerOrganizationId, request.query.ownerOrganizationId)
        : scope.all
          ? undefined
          : scope.orgIds.length > 0
            ? // We use inArray equivalent — but the Drizzle inArray would
              // be cleaner; since the filter is optional anyway and the
              // result is bounded, just iterate at the application layer
              // when not platform.
              undefined
            : undefined;
      const rows = await db.query.procedureDraftRuns.findMany({
        where: filter,
        orderBy: [desc(schema.procedureDraftRuns.createdAt)],
        limit: request.query.limit,
      });
      // App-layer scope filter for non-platform callers without org filter.
      const visible = scope.all
        ? rows
        : rows.filter((r) => scope.orgIds.includes(r.ownerOrganizationId));
      return visible.map(runToDTO);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/procedure-drafts/:id — full state (run + proposal + execs)
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/admin/procedure-drafts/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);

      const proposal = await db.query.procedureDraftProposals.findFirst({
        where: eq(schema.procedureDraftProposals.runId, run.id),
      });
      const executions = await db.query.procedureDraftExecutions.findMany({
        where: proposal
          ? eq(schema.procedureDraftExecutions.proposalId, proposal.id)
          : undefined,
        orderBy: [desc(schema.procedureDraftExecutions.startedAt)],
        limit: 10,
      });

      return {
        run: runToDTO(run),
        proposal: proposal ? proposalToDTO(proposal) : null,
        executions: executions.map((e) => ({
          id: e.id,
          status: e.status,
          proposalVersion: e.proposalVersion,
          error: e.error,
          startedAt: e.startedAt.toISOString(),
          finishedAt: e.finishedAt?.toISOString() ?? null,
        })),
        playbackId: run.muxPlaybackId,
        transcript: run.sourceTranscript,
      };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-drafts/:id/proposal — optimistic edit
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: z.infer<typeof ProposalPatchBody>;
  }>(
    '/admin/procedure-drafts/:id/proposal',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: ProposalPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      const proposal = await db.query.procedureDraftProposals.findFirst({
        where: eq(schema.procedureDraftProposals.runId, run.id),
      });
      if (!proposal) return reply.notFound('no proposal yet');
      if (proposal.version !== request.body.version) {
        return reply.code(409).send({
          error: 'proposal version mismatch',
          currentVersion: proposal.version,
        });
      }
      const [updated] = await db
        .update(schema.procedureDraftProposals)
        .set({
          content: request.body.content,
          version: proposal.version + 1,
          summary: request.body.content.summary ?? proposal.summary,
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureDraftProposals.id, proposal.id))
        .returning();
      if (!updated) return reply.internalServerError('proposal update failed');
      await db.insert(schema.auditEvents).values({
        organizationId: run.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_draft.proposal_edited',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: { version: updated.version, stepCount: request.body.content.steps.length },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return proposalToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/procedure-drafts/:id/execute — materialize a procedure
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/procedure-drafts/:id/execute',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      if (run.status !== 'awaiting_review' && run.status !== 'completed' && run.status !== 'failed') {
        return reply.conflict(`cannot execute in status '${run.status}'`);
      }
      const proposal = await db.query.procedureDraftProposals.findFirst({
        where: eq(schema.procedureDraftProposals.runId, run.id),
      });
      if (!proposal) return reply.badRequest('no proposal to execute');

      // Mint the target document up-front so the executor has a stable
      // target. Auto-extracted summary becomes the doc bodyMarkdown for
      // the procedure intro.
      const [doc] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: run.targetContentPackVersionId,
          kind: 'structured_procedure',
          title: run.proposedTitle,
          bodyMarkdown:
            typeof (proposal.content as DraftProposalTree).summary === 'string'
              ? ((proposal.content as DraftProposalTree).summary ?? '')
              : '',
          extractionStatus: 'ready',
          language: 'en',
          aiIndexed: true,
        })
        .returning();
      if (!doc) return reply.internalServerError('failed to create target document');

      const [execution] = await db
        .insert(schema.procedureDraftExecutions)
        .values({
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          startedByUserId: auth.userId,
          status: 'running',
        })
        .returning();
      if (!execution) {
        return reply.internalServerError('failed to create execution row');
      }

      const tree = (proposal.content as DraftProposalTree);
      const ac = new AbortController();
      executionAborts.set(execution.id, ac);

      // Fire-and-forget. SSE listeners see progress.
      setImmediate(() => {
        runDrafterExecution({
          app,
          runId: run.id,
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          executionId: execution.id,
          actorUserId: auth.userId,
          targetDocumentId: doc.id,
          proposal: tree,
          signal: ac.signal,
        })
          .catch((err) => {
            app.log.error({ err, runId: run.id }, 'draft execute failed');
          })
          .finally(() => {
            executionAborts.delete(execution.id);
          });
      });

      await db.insert(schema.auditEvents).values({
        organizationId: run.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_draft.executed',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {
          executionId: execution.id,
          stepCount: tree.steps.length,
          targetDocumentId: doc.id,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      // Mint an SSE stream token (reusing the agent stream-token issuer
      // when configured) for the reviewer page.
      const streamToken = app.ctx.streamTokens
        ? app.ctx.streamTokens.mint({
            runId: run.id,
            userId: auth.userId,
            purpose: 'execute',
          })
        : null;

      return reply.code(202).send({
        executionId: execution.id,
        targetDocumentId: doc.id,
        streamToken,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/procedure-drafts/:id/cancel — best-effort abort
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/procedure-drafts/:id/cancel',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      if (
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled'
      ) {
        return { ok: true, alreadyTerminal: true };
      }
      // Abort the in-process execution if any.
      const proposal = await db.query.procedureDraftProposals.findFirst({
        where: eq(schema.procedureDraftProposals.runId, run.id),
      });
      if (proposal) {
        const executions = await db.query.procedureDraftExecutions.findMany({
          where: and(
            eq(schema.procedureDraftExecutions.proposalId, proposal.id),
            eq(schema.procedureDraftExecutions.status, 'running'),
          ),
        });
        for (const exec of executions) {
          const ac = executionAborts.get(exec.id);
          if (ac) ac.abort(new Error('cancelled by user'));
        }
      }
      await db
        .update(schema.procedureDraftRuns)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(schema.procedureDraftRuns.id, run.id));
      await db.insert(schema.auditEvents).values({
        organizationId: run.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_draft.cancelled',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {},
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      agentBus.publish(runChannel(run.id, 'propose'), 'cancelled', {});
      agentBus.publish(runChannel(run.id, 'execute'), 'cancelled', {});
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/procedure-drafts/:id/events?token=...&purpose=propose|execute
  //
  // SSE pipe from agentBus. Auth via the short-lived stream token to
  // dodge the EventSource credentials-cookie limitation.
  // -------------------------------------------------------------------------
  app.get<{
    Params: { id: string };
    Querystring: { token: string; purpose?: 'propose' | 'execute'; lastEventId?: string };
  }>(
    '/admin/procedure-drafts/:id/events',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        querystring: z.object({
          token: z.string().min(1),
          purpose: z.enum(['propose', 'execute']).optional(),
          lastEventId: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      if (!app.ctx.streamTokens) {
        return reply.serviceUnavailable('stream tokens not configured');
      }
      const purpose = request.query.purpose ?? 'propose';
      const payload = app.ctx.streamTokens.verify(request.query.token, {
        runId: request.params.id,
        purpose,
      });
      if (!payload) return reply.unauthorized('invalid stream token');

      const lastEventId =
        typeof request.query.lastEventId === 'number'
          ? request.query.lastEventId
          : Number(request.query.lastEventId ?? 0);
      const sse = startSse(request, reply, {
        startEventId: Number.isFinite(lastEventId) ? lastEventId : 0,
      });
      sse.send('open', { runId: request.params.id, purpose });
      const unsub = agentBus.subscribe(
        runChannel(request.params.id, purpose),
        (evt) => sse.send(evt.type, { ...evt.data, _eventId: evt.id, _ts: evt.ts }),
        Number.isFinite(lastEventId) ? lastEventId : undefined,
      );
      sse.done.finally(unsub);
    },
  );
}

// Re-export the webhook handlers so admin-agent.ts can dispatch on
// passthrough prefix without importing draft-pipeline directly. Keeps the
// agent file free of drafter knowledge beyond a single `if`.
export {
  parseDraftPassthrough,
  onDraftMuxAssetCreated,
  onDraftMuxAssetReady,
  onDraftMuxTrackReady,
  onDraftMuxErrored,
};
