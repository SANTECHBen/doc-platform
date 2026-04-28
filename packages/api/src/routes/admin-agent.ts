// Admin onboarding agent routes.
//
// All endpoints under /admin/agent/* require platform_admin in v1. The Mux
// webhook is a separate endpoint — verified by HMAC signature, not by user
// auth.
//
// Lifecycle:
//   1. POST /admin/agent/runs                     — create with manifest
//   2. POST /admin/agent/runs/:id/upload          — upload non-video files
//   3. POST /admin/agent/runs/:id/mux/upload      — mint Mux Direct Upload
//                                                   per video (browser PUTs
//                                                   directly to Mux)
//   4. POST /admin/agent/runs/:id/propose         — kick off LLM phase
//      → server starts agent loop async
//      → client connects EventSource to .../propose/stream?token=...
//   5. PATCH /admin/agent/proposals/:id           — admin edits
//   6. POST /admin/agent/proposals/:id/execute    — apply against admin APIs
//      → client connects EventSource to .../executions/:id/stream
//
// Two SSE streams (propose + execute) — both use short-lived HMAC tokens
// because EventSource can't set headers.

import type { FastifyInstance } from 'fastify';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { schema } from '@platform/db';
import { z } from 'zod';
import { ManifestSchema, ProposalTreeSchema } from '@platform/ai';
import { requireAuth } from '../middleware/auth.js';
import { startSse } from '../lib/sse.js';
import { agentBus, runChannel } from '../lib/agent-bus.js';
import { runProposePhase } from '../lib/agent-runner.js';

export async function registerAdminAgent(app: FastifyInstance) {
  if (app.ctx.env.AGENT_ENABLED !== '1') {
    app.log.info('AGENT_ENABLED != 1, skipping admin-agent route registration');
    return;
  }
  if (!app.ctx.streamTokens) {
    throw new Error('streamTokens not initialized in context — cannot register agent routes');
  }
  const tokens = app.ctx.streamTokens;

  function requirePlatformAdmin(request: import('fastify').FastifyRequest) {
    const auth = requireAuth(request);
    if (!auth.platformAdmin) {
      const err = new Error('Platform admin only') as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
    return auth;
  }

  // -------------------------------------------------------------------------
  // POST /admin/agent/runs — create run + accept manifest
  // -------------------------------------------------------------------------
  app.post('/admin/agent/runs', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const body = z
      .object({ manifest: ManifestSchema })
      .parse(request.body);

    const [run] = await app.ctx.db
      .insert(schema.agentRuns)
      .values({
        createdByUserId: auth.userId,
        manifest: body.manifest,
        status: 'uploading',
      })
      .returning();
    if (!run) return reply.internalServerError('Failed to create agent run');

    return { runId: run.id, status: run.status };
  });

  // -------------------------------------------------------------------------
  // GET /admin/agent/runs — list user's runs
  // -------------------------------------------------------------------------
  app.get('/admin/agent/runs', async (request) => {
    const auth = requirePlatformAdmin(request);
    const rows = await app.ctx.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.createdByUserId, auth.userId))
      .orderBy(desc(schema.agentRuns.createdAt))
      .limit(50);
    return (rows as Array<typeof schema.agentRuns.$inferSelect>).map((r) => ({
      id: r.id,
      status: r.status,
      manifestRoot: (r.manifest as { rootName?: string } | null)?.rootName ?? null,
      manifestFiles: (r.manifest as { totalFiles?: number } | null)?.totalFiles ?? 0,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  });

  // -------------------------------------------------------------------------
  // GET /admin/agent/runs/:id — full run + proposal + files
  // -------------------------------------------------------------------------
  app.get('/admin/agent/runs/:id', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const run = await app.ctx.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, id),
    });
    if (!run || run.createdByUserId !== auth.userId) return reply.notFound();

    const [files, proposal] = await Promise.all([
      app.ctx.db.query.agentRunFiles.findMany({
        where: eq(schema.agentRunFiles.runId, id),
      }),
      app.ctx.db.query.agentProposals.findFirst({
        where: eq(schema.agentProposals.runId, id),
      }),
    ]);

    return {
      run: {
        id: run.id,
        status: run.status,
        manifest: run.manifest,
        error: run.error,
        targetOrganizationId: run.targetOrganizationId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      },
      files: (files as Array<typeof schema.agentRunFiles.$inferSelect>).map((f) => ({
        id: f.id,
        relativePath: f.relativePath,
        size: f.size,
        contentType: f.contentType,
        status: f.status,
        storageKey: f.storageKey,
        muxUploadId: f.muxUploadId,
        muxAssetId: f.muxAssetId,
        streamPlaybackId: f.streamPlaybackId,
      })),
      proposal: proposal
        ? {
            id: proposal.id,
            version: proposal.version,
            content: proposal.content,
            summary: proposal.summary,
            modelUsed: proposal.modelUsed,
            tokenUsage: proposal.tokenUsage,
            updatedAt: proposal.updatedAt,
          }
        : null,
    };
  });

  // -------------------------------------------------------------------------
  // POST /admin/agent/runs/:id/upload — multipart upload, links to run
  // -------------------------------------------------------------------------
  // Hard-rejects video MIME types (>= 100 MB or video/*) — those go through
  // the Mux Direct Upload path. Everything else lands in S3 and gets an
  // agent_run_files row with status='uploaded'.
  app.post('/admin/agent/runs/:id/upload', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const run = await app.ctx.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, id),
    });
    if (!run || run.createdByUserId !== auth.userId) return reply.notFound();

    const file = await request.file();
    if (!file) return reply.badRequest('No file provided');
    const relativePath = (file.fields['relativePath'] as { value?: string } | undefined)?.value;
    if (!relativePath) {
      return reply.badRequest('Missing relativePath form field');
    }

    const mime = file.mimetype ?? 'application/octet-stream';
    if (mime.startsWith('video/')) {
      return reply
        .code(415)
        .send({ error: 'video uploads must use the Mux direct upload endpoint' });
    }

    const buffer = await file.toBuffer();
    if (buffer.length > 100 * 1024 * 1024) {
      return reply.code(413).send({ error: 'file exceeds 100MB; use Mux for large media' });
    }
    const stored = await app.ctx.storage.putBuffer({
      buffer,
      filename: file.filename ?? 'file',
      contentType: mime,
    });

    const [row] = await app.ctx.db
      .insert(schema.agentRunFiles)
      .values({
        runId: id,
        relativePath,
        sha256: stored.sha256,
        size: stored.size,
        contentType: mime,
        storageKey: stored.storageKey,
        status: 'uploaded',
      })
      .onConflictDoUpdate({
        target: [schema.agentRunFiles.runId, schema.agentRunFiles.relativePath],
        set: {
          sha256: stored.sha256,
          size: stored.size,
          contentType: mime,
          storageKey: stored.storageKey,
          status: 'uploaded',
          updatedAt: new Date(),
        },
      })
      .returning();
    return { runFileId: row?.id, storageKey: stored.storageKey };
  });

  // -------------------------------------------------------------------------
  // POST /admin/agent/runs/:id/mux/upload — mint Mux Direct Upload
  // -------------------------------------------------------------------------
  app.post('/admin/agent/runs/:id/mux/upload', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    if (!app.ctx.mux) return reply.serviceUnavailable('Mux not configured');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const run = await app.ctx.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, id),
    });
    if (!run || run.createdByUserId !== auth.userId) return reply.notFound();

    const body = z
      .object({
        relativePath: z.string().min(1),
        size: z.number().int().nonnegative(),
        contentType: z.string().min(1),
      })
      .parse(request.body);

    // Insert (or upsert) the run file row first so we have an id to use as
    // the Mux upload `passthrough`. The webhook uses this id to find the row.
    const [fileRow] = await app.ctx.db
      .insert(schema.agentRunFiles)
      .values({
        runId: id,
        relativePath: body.relativePath,
        size: body.size,
        contentType: body.contentType,
        status: 'pending',
      })
      .onConflictDoUpdate({
        target: [schema.agentRunFiles.runId, schema.agentRunFiles.relativePath],
        set: {
          size: body.size,
          contentType: body.contentType,
          status: 'pending',
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!fileRow) return reply.internalServerError('Failed to record run file');

    const upload = await app.ctx.mux.createDirectUpload({ passthrough: fileRow.id });
    await app.ctx.db
      .update(schema.agentRunFiles)
      .set({ muxUploadId: upload.uploadId, status: 'mux_processing', updatedAt: new Date() })
      .where(eq(schema.agentRunFiles.id, fileRow.id));

    return {
      runFileId: fileRow.id,
      uploadId: upload.uploadId,
      uploadUrl: upload.uploadUrl,
    };
  });

  // -------------------------------------------------------------------------
  // POST /admin/webhooks/mux — Mux upload + asset event handler
  // -------------------------------------------------------------------------
  // No auth — verified via HMAC signature in the Mux SDK.
  app.post('/admin/webhooks/mux', { config: { rawBody: true } }, async (request, reply) => {
    if (!app.ctx.mux || !app.ctx.env.MUX_WEBHOOK_SECRET) {
      return reply.serviceUnavailable('Mux not configured');
    }
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    let event: Awaited<ReturnType<typeof app.ctx.mux.unwrapWebhook>>;
    try {
      event = await app.ctx.mux.unwrapWebhook(
        raw,
        request.headers as Record<string, string | string[] | undefined>,
        app.ctx.env.MUX_WEBHOOK_SECRET,
      );
    } catch (err) {
      app.log.warn({ err }, 'mux webhook signature failed');
      return reply.code(400).send({ error: 'invalid signature' });
    }

    if (event.type === 'video.upload.asset_created' && event.data && 'asset_id' in event.data) {
      const passthrough = (event.data as { passthrough?: string }).passthrough;
      const assetId = (event.data as { asset_id?: string }).asset_id;
      if (passthrough && assetId) {
        await app.ctx.db
          .update(schema.agentRunFiles)
          .set({ muxAssetId: assetId, updatedAt: new Date() })
          .where(eq(schema.agentRunFiles.id, passthrough));
      }
    } else if (event.type === 'video.asset.ready' && event.data) {
      const passthrough = (event.data as { passthrough?: string }).passthrough;
      const playbackIds = (
        event.data as { playback_ids?: Array<{ id: string; policy: string }> }
      ).playback_ids;
      const playbackId = playbackIds?.[0]?.id;
      if (passthrough) {
        const [updated] = await app.ctx.db
          .update(schema.agentRunFiles)
          .set({
            streamPlaybackId: playbackId ?? null,
            status: 'ready',
            updatedAt: new Date(),
          })
          .where(eq(schema.agentRunFiles.id, passthrough))
          .returning();
        if (updated) {
          // If a propose stream is open, broadcast.
          agentBus.publish(runChannel(updated.runId, 'propose'), 'mux_ready', {
            runFileId: updated.id,
            relativePath: updated.relativePath,
            streamPlaybackId: playbackId,
          });
          agentBus.publish(runChannel(updated.runId, 'execute'), 'mux_ready', {
            runFileId: updated.id,
            relativePath: updated.relativePath,
            streamPlaybackId: playbackId,
          });
        }
      }
    } else if (event.type === 'video.asset.errored' && event.data) {
      const passthrough = (event.data as { passthrough?: string }).passthrough;
      const errors = (event.data as { errors?: { messages?: string[] } }).errors;
      if (passthrough) {
        await app.ctx.db
          .update(schema.agentRunFiles)
          .set({
            status: 'failed',
            error: errors?.messages?.join('; ') ?? 'Mux asset errored',
            updatedAt: new Date(),
          })
          .where(eq(schema.agentRunFiles.id, passthrough));
      }
    }

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // POST /admin/agent/runs/:id/propose — kick off LLM, return streamToken
  // -------------------------------------------------------------------------
  app.post('/admin/agent/runs/:id/propose', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const run = await app.ctx.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, id),
    });
    if (!run || run.createdByUserId !== auth.userId) return reply.notFound();
    if (run.status === 'proposing' || run.status === 'executing') {
      return reply.conflict(`Run already ${run.status}`);
    }

    const streamToken = tokens.mint({
      runId: id,
      userId: auth.userId,
      purpose: 'propose',
    });

    // Fire-and-forget: agent loop runs async, broadcasting via agentBus.
    setImmediate(() => {
      runProposePhase({ app, runId: id }).catch((err) => {
        app.log.error({ err, runId: id }, 'runProposePhase rejected');
      });
    });

    return { runId: id, streamToken };
  });

  // -------------------------------------------------------------------------
  // GET /admin/agent/runs/:id/propose/stream?token=... — SSE
  // -------------------------------------------------------------------------
  app.get('/admin/agent/runs/:id/propose/stream', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { token, lastEventId } = z
      .object({
        token: z.string().min(1),
        lastEventId: z.coerce.number().optional(),
      })
      .parse(request.query);
    const payload = tokens.verify(token, { runId: id, purpose: 'propose' });
    if (!payload) return reply.unauthorized('invalid stream token');

    const sse = startSse(request, reply, { startEventId: lastEventId ?? 0 });
    sse.send('open', { runId: id, purpose: 'propose' });
    const unsub = agentBus.subscribe(
      runChannel(id, 'propose'),
      (evt) => sse.send(evt.type, { ...evt.data, _eventId: evt.id, _ts: evt.ts }),
      lastEventId,
    );
    sse.done.finally(unsub);
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/agent/proposals/:id — admin edits with optimistic concurrency
  // -------------------------------------------------------------------------
  app.patch('/admin/agent/proposals/:id', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        version: z.number().int().positive(),
        content: ProposalTreeSchema,
      })
      .parse(request.body);

    // Authorize via the run's createdByUserId.
    const proposal = await app.ctx.db.query.agentProposals.findFirst({
      where: eq(schema.agentProposals.id, id),
    });
    if (!proposal) return reply.notFound();
    const run = await app.ctx.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, proposal.runId),
    });
    if (!run || run.createdByUserId !== auth.userId) return reply.notFound();
    if (proposal.version !== body.version) {
      return reply.code(409).send({
        error: 'proposal version mismatch',
        currentVersion: proposal.version,
      });
    }

    const [updated] = await app.ctx.db
      .update(schema.agentProposals)
      .set({
        content: body.content,
        version: proposal.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentProposals.id, id))
      .returning();

    return {
      id: updated?.id,
      version: updated?.version,
      updatedAt: updated?.updatedAt,
    };
  });

  // -------------------------------------------------------------------------
  // POST /admin/agent/proposals/:id/execute — start execute, return streamToken
  // -------------------------------------------------------------------------
  // The actual executor implementation lives in agent-executor.ts and is
  // wired in once Task #7 lands. For now we record the execution row and
  // emit a status event; clients can connect to the stream.
  app.post('/admin/agent/proposals/:id/execute', async (request, reply) => {
    const auth = requirePlatformAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const proposal = await app.ctx.db.query.agentProposals.findFirst({
      where: eq(schema.agentProposals.id, id),
    });
    if (!proposal) return reply.notFound();
    const run = await app.ctx.db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, proposal.runId),
    });
    if (!run || run.createdByUserId !== auth.userId) return reply.notFound();

    const [exec] = await app.ctx.db
      .insert(schema.agentExecutions)
      .values({
        proposalId: id,
        proposalVersion: proposal.version,
        startedByUserId: auth.userId,
        status: 'running',
      })
      .returning();
    if (!exec) return reply.internalServerError();

    await app.ctx.db
      .update(schema.agentRuns)
      .set({ status: 'executing', updatedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));

    const streamToken = tokens.mint({
      runId: run.id,
      userId: auth.userId,
      purpose: 'execute',
    });

    // Lazy-import to avoid a startup-time circular if executor is heavy.
    setImmediate(async () => {
      try {
        const { runExecutePhase } = await import('../lib/agent-executor.js');
        await runExecutePhase({ app, executionId: exec.id });
      } catch (err) {
        app.log.error({ err, executionId: exec.id }, 'runExecutePhase rejected');
      }
    });

    return { executionId: exec.id, runId: run.id, streamToken };
  });

  // -------------------------------------------------------------------------
  // GET /admin/agent/runs/:id/execute/stream?token=... — SSE for execute
  // -------------------------------------------------------------------------
  app.get('/admin/agent/runs/:id/execute/stream', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { token, lastEventId } = z
      .object({
        token: z.string().min(1),
        lastEventId: z.coerce.number().optional(),
      })
      .parse(request.query);
    const payload = tokens.verify(token, { runId: id, purpose: 'execute' });
    if (!payload) return reply.unauthorized('invalid stream token');

    const sse = startSse(request, reply, { startEventId: lastEventId ?? 0 });
    sse.send('open', { runId: id, purpose: 'execute' });
    const unsub = agentBus.subscribe(
      runChannel(id, 'execute'),
      (evt) => sse.send(evt.type, { ...evt.data, _eventId: evt.id, _ts: evt.ts }),
      lastEventId,
    );
    sse.done.finally(unsub);
  });

  // Silence unused-import warnings — these will be used once the executor
  // and tests land.
  void and;
  void inArray;
}
