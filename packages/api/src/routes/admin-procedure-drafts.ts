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
  DraftDocProposalTreeSchema,
  type DraftProposalTree,
  type DraftDocProposalTree,
} from '@platform/ai';
import { UuidSchema } from '@platform/shared';
import { recordAudit } from '../lib/audit.js';
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
  refreshDraftFromMux,
  runDrafterExecution,
  startDrafterLoop,
} from '../services/draft-pipeline.js';
import {
  deriveOutline,
  startDocExtraction,
  startDocDrafterLoop,
  runDocDrafterExecution,
} from '../services/doc-draft-pipeline.js';

// Source document upload limits for the doc-import path.
const MAX_DOC_BYTES = 50 * 1024 * 1024; // 50 MB — LlamaParse/mammoth ceiling
const DOC_MIME_TO_KIND: Record<string, 'docx' | 'pdf'> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
};

const CreateBody = z.object({
  proposedTitle: z.string().min(1).max(200),
  targetContentPackVersionId: UuidSchema,
  ownerOrganizationId: UuidSchema,
  /** Optional up-front category pick — admin-initiated drafts usually
   *  know what they're filming. PWA-submitted drafts set this later via
   *  PATCH /:id/category before tapping "Run AI". */
  procedureCategory: z
    .enum([
      'preventive_maintenance',
      'removal_replacement',
      'troubleshooting',
      'walkthrough',
    ])
    .optional(),
});

const ListQuery = z.object({
  ownerOrganizationId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ProposalPatchBody = z.object({
  version: z.number().int().positive(),
  // A run is either a video draft (DraftProposalTree) or a document-import
  // draft (DraftDocProposalTree). Try the doc schema first — it pins
  // source:'document', so a video tree can't match it, and a doc tree (no
  // clip fields) can't match the video schema. The handler doesn't need to
  // know which won; the content is stored as-is.
  content: z.union([DraftDocProposalTreeSchema, DraftProposalTreeSchema]),
});

const SectionsPickBody = z.object({
  selectedSectionTitles: z.array(z.string().min(1).max(200)).min(1).max(50),
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
    sourceVideoAspectRatio: r.sourceVideoAspectRatio,
    sourceVideoOrientation: r.sourceVideoOrientation,
    procedureCategory: r.procedureCategory,
    transcriptSource: r.transcriptSource,
    hasTranscript: !!r.sourceTranscript,
    hasStoryboard: !!r.storyboardVttUrl,
    // Document-import source fields. sourceKind discriminates the UI: 'video'
    // shows the Mux reviewer, 'docx'/'pdf' shows the section picker + figure
    // thumbnails and hides the clip slider.
    sourceKind: r.sourceKind,
    hasSourceMarkdown: !!r.sourceMarkdown,
    selectedSectionTitles: r.selectedSectionTitles ?? null,
    figureCount: r.figuresManifest?.length ?? 0,
    error: r.error,
    // PWA-submission provenance — surfaces a "Submitted by tech" badge
    // and the asset context strip on the admin reviewer.
    pwaSubmitted: r.pwaSubmitted,
    submittedByUserId: r.submittedByUserId,
    submittedFromAssetInstanceId: r.submittedFromAssetInstanceId,
    submissionNotes: r.submissionNotes,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const ProcedureCategorySchema = z.enum([
  'preventive_maintenance',
  'removal_replacement',
  'troubleshooting',
  'walkthrough',
]);

function proposalToDTO(p: typeof schema.procedureDraftProposals.$inferSelect) {
  return {
    id: p.id,
    runId: p.runId,
    version: p.version,
    // Either a video or document proposal tree — the client branches on the
    // run's sourceKind (and the tree's `source` discriminator) to render.
    content: p.content as DraftProposalTree | DraftDocProposalTree,
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
          procedureCategory: body.procedureCategory ?? null,
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

      await recordAudit(db, request, {
        organizationId: body.ownerOrganizationId,
        eventType: 'procedure_draft.created',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {
          proposedTitle: body.proposedTitle,
          targetContentPackVersionId: body.targetContentPackVersionId,
        },
      });

      return reply.code(201).send({
        runId: run.id,
        uploadId: upload.uploadId,
        uploadUrl: upload.uploadUrl,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/procedure-drafts/document — create a doc-import draft.
  //
  // Multipart: a .docx/.pdf file plus form fields (proposedTitle,
  // targetContentPackVersionId, ownerOrganizationId, procedureCategory?).
  // Stores the file, creates the run with sourceKind, and kicks extraction
  // (parse → figures → await section pick). No Mux.
  // -------------------------------------------------------------------------
  app.post('/admin/procedure-drafts/document', async (request, reply) => {
    const { db, storage } = app.ctx;
    const auth = requireAuth(request);
    const scope = await getScope(request, db);

    if (!request.isMultipart()) {
      return reply.badRequest('Expected multipart/form-data with a document file.');
    }
    const file = await request.file();
    if (!file) return reply.badRequest('Missing document file.');

    const mime = (file.mimetype || '').toLowerCase();
    const sourceKind = DOC_MIME_TO_KIND[mime];
    if (!sourceKind) {
      return reply.unsupportedMediaType(
        `Unsupported document type: ${mime}. Upload a Word (.docx) or PDF file.`,
      );
    }

    // Form fields ride alongside the file part.
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const proposedTitle = (fields.proposedTitle?.value ?? '').trim();
    const targetContentPackVersionId = fields.targetContentPackVersionId?.value ?? '';
    const ownerOrganizationId = fields.ownerOrganizationId?.value ?? '';
    const procedureCategoryRaw = fields.procedureCategory?.value;

    if (!proposedTitle) return reply.badRequest('proposedTitle is required.');
    const ids = z
      .object({
        targetContentPackVersionId: UuidSchema,
        ownerOrganizationId: UuidSchema,
      })
      .safeParse({ targetContentPackVersionId, ownerOrganizationId });
    if (!ids.success) {
      return reply.badRequest('targetContentPackVersionId and ownerOrganizationId must be UUIDs.');
    }
    const procedureCategory = ProcedureCategorySchema.safeParse(procedureCategoryRaw);
    requireOrgInScope(scope, ids.data.ownerOrganizationId);

    // Verify the content pack version belongs to the org.
    const version = await db.query.contentPackVersions.findFirst({
      where: eq(schema.contentPackVersions.id, ids.data.targetContentPackVersionId),
      with: { pack: true },
    });
    if (!version) return reply.notFound('content_pack_version not found');
    if (version.pack.ownerOrganizationId !== ids.data.ownerOrganizationId) {
      return reply.badRequest(
        'ownerOrganizationId does not match the content pack version owner',
      );
    }

    // Read + size-check the file.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of file.file as unknown as AsyncIterable<Buffer>) {
      total += c.byteLength;
      if (total > MAX_DOC_BYTES) {
        return reply.payloadTooLarge('Document exceeds 50 MB limit.');
      }
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (buf.byteLength === 0) return reply.badRequest('Empty document.');

    const stored = await storage.putBuffer({
      buffer: buf,
      filename: file.filename || `procedure.${sourceKind}`,
      contentType: mime,
      ownerOrganizationId: ids.data.ownerOrganizationId,
    });

    const [run] = await db
      .insert(schema.procedureDraftRuns)
      .values({
        ownerOrganizationId: ids.data.ownerOrganizationId,
        targetContentPackVersionId: ids.data.targetContentPackVersionId,
        proposedTitle,
        status: 'extracting',
        sourceKind,
        sourceStorageKey: stored.storageKey,
        procedureCategory: procedureCategory.success ? procedureCategory.data : null,
        createdByUserId: auth.userId,
      })
      .returning();
    if (!run) return reply.internalServerError('Failed to create draft run');

    await recordAudit(db, request, {
      organizationId: ids.data.ownerOrganizationId,
      eventType: 'procedure_draft.created',
      targetType: 'procedure_draft_run',
      targetId: run.id,
      payload: { proposedTitle, sourceKind, sizeBytes: stored.size },
    });

    // Fire-and-forget extraction; the reviewer page subscribes to SSE.
    setImmediate(() => {
      startDocExtraction(app, run.id).catch((err) => {
        app.log.error({ err, runId: run.id }, 'doc draft extraction failed');
      });
    });

    const streamToken = app.ctx.streamTokens
      ? app.ctx.streamTokens.mint({ runId: run.id, userId: auth.userId, purpose: 'propose' })
      : null;

    return reply.code(201).send({ runId: run.id, sourceKind, streamToken });
  });

  // -------------------------------------------------------------------------
  // POST /admin/procedure-drafts/:id/sections — pick which procedures
  // (document sections) to generate, then kick the LLM drafter. Doc-import
  // runs only.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: z.infer<typeof SectionsPickBody> }>(
    '/admin/procedure-drafts/:id/sections',
    { schema: { params: z.object({ id: UuidSchema }), body: SectionsPickBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      if (run.sourceKind === 'video') {
        return reply.badRequest('section pick applies only to document-import drafts');
      }
      if (run.status !== 'awaiting_section_pick') {
        return reply.conflict(
          `cannot pick sections in status '${run.status}' — expected awaiting_section_pick`,
        );
      }
      await db
        .update(schema.procedureDraftRuns)
        .set({
          selectedSectionTitles: request.body.selectedSectionTitles,
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureDraftRuns.id, run.id));

      setImmediate(() => {
        startDocDrafterLoop(app, run.id).catch((err) => {
          app.log.error({ err, runId: run.id }, 'doc draft loop failed');
        });
      });

      await recordAudit(db, request, {
        organizationId: run.ownerOrganizationId,
        eventType: 'procedure_draft.sections_picked',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: { sections: request.body.selectedSectionTitles },
      });

      const streamToken = app.ctx.streamTokens
        ? app.ctx.streamTokens.mint({ runId: run.id, userId: auth.userId, purpose: 'propose' })
        : null;
      return reply.code(202).send({ ok: true, streamToken });
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

      // Doc-import runs surface the heading outline (for the section picker)
      // and signed figure thumbnail URLs (for the reviewer). Video runs leave
      // both null and use playbackId/transcript instead.
      const isDoc = run.sourceKind === 'docx' || run.sourceKind === 'pdf';
      const documentOutline =
        isDoc && run.sourceMarkdown ? deriveOutline(run.sourceMarkdown) : null;
      const figures = isDoc
        ? await Promise.all(
            (run.figuresManifest ?? []).map(async (f) => ({
              figureId: f.figureId,
              caption: f.caption ?? null,
              width: f.width ?? null,
              height: f.height ?? null,
              url: await app.ctx.storage.signedUrl(f.storageKey, {
                ttlSeconds: 3600,
              }),
            })),
          )
        : null;

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
        documentOutline,
        figures,
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
      await recordAudit(db, request, {
        organizationId: run.ownerOrganizationId,
        eventType: 'procedure_draft.proposal_edited',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: { version: updated.version, stepCount: request.body.content.steps.length },
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
      const summaryText =
        typeof (proposal.content as DraftProposalTree).summary === 'string'
          ? ((proposal.content as DraftProposalTree).summary ?? '')
          : '';
      const [doc] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: run.targetContentPackVersionId,
          kind: 'structured_procedure',
          title: run.proposedTitle,
          bodyMarkdown: summaryText,
          extractionStatus: 'ready',
          language: 'en',
          aiIndexed: true,
          // Carry the draft's category onto the published procedure so
          // the PWA's Maintenance tab files it into the correct card
          // (PM / R&R / Troubleshooting / Walkthrough) without an admin
          // having to Edit-procedure and re-pick it. Column is
          // `procedure_metadata`; an earlier `metadata:` typo here was
          // silently dropped by drizzle, leaving every promoted draft
          // with category=null → PWA defaulted them all into PM.
          procedureMetadata: {
            toolsRequired: { common: [], special: [], consumables: [] },
            safety: { enabled: false, notes: null },
            verification: { enabled: false, notes: null },
            category: run.procedureCategory ?? null,
            summary: summaryText || null,
          },
        })
        .returning();
      if (!doc) return reply.internalServerError('failed to create target document');

      // Link the document to the run up-front. The executor also sets this at
      // completion, but setting it now guarantees the reviewer can always
      // navigate to the procedure — even if the executor errors partway —
      // instead of a completed run being left with a null targetDocumentId
      // (which leaves the reviewer spinning forever on "Opening the editor").
      await db
        .update(schema.procedureDraftRuns)
        .set({ targetDocumentId: doc.id, updatedAt: new Date() })
        .where(eq(schema.procedureDraftRuns.id, run.id));

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

      const isDoc = run.sourceKind === 'docx' || run.sourceKind === 'pdf';
      const tree = proposal.content as DraftProposalTree | DraftDocProposalTree;
      const ac = new AbortController();
      executionAborts.set(execution.id, ac);

      // Fire-and-forget. SSE listeners see progress. Doc-import runs use the
      // document executor (sections + figures, no Mux); video runs use the
      // original keyframe/clip executor.
      setImmediate(() => {
        const work = isDoc
          ? runDocDrafterExecution({
              app,
              runId: run.id,
              proposalId: proposal.id,
              executionId: execution.id,
              actorUserId: auth.userId,
              targetDocumentId: doc.id,
              proposal: tree as DraftDocProposalTree,
              signal: ac.signal,
            })
          : runDrafterExecution({
              app,
              runId: run.id,
              proposalId: proposal.id,
              proposalVersion: proposal.version,
              executionId: execution.id,
              actorUserId: auth.userId,
              targetDocumentId: doc.id,
              proposal: tree as DraftProposalTree,
              signal: ac.signal,
            });
        work
          .catch((err) => {
            app.log.error({ err, runId: run.id }, 'draft execute failed');
          })
          .finally(() => {
            executionAborts.delete(execution.id);
          });
      });

      await recordAudit(db, request, {
        organizationId: run.ownerOrganizationId,
        eventType: 'procedure_draft.executed',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {
          executionId: execution.id,
          stepCount: tree.steps.length,
          targetDocumentId: doc.id,
        },
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
  // POST /admin/procedure-drafts/:id/run-ai — start the LLM for a
  // PWA-submitted draft that's been pending admin decision.
  //
  // The pipeline gates LLM cost behind this admin action for PWA-
  // initiated drafts. The transcript is already present (Mux captions
  // or Whisper fallback ran automatically); this kicks off Claude Opus
  // 4.7 to segment it into proposed steps.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/procedure-drafts/:id/run-ai',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      if (run.status !== 'pending_admin_decision') {
        return reply.conflict(
          `cannot run AI in status '${run.status}' — expected pending_admin_decision`,
        );
      }
      // Kick the loop async — same fire-and-forget pattern as the
      // automatic path, so the route returns immediately and the SSE
      // stream surfaces progress.
      setImmediate(() => {
        startDrafterLoop(app, run.id).catch((err) => {
          app.log.error({ err, runId: run.id }, 'run-ai: loop failed');
        });
      });
      await recordAudit(db, request, {
        organizationId: run.ownerOrganizationId,
        eventType: 'procedure_draft.ai_started',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {
          pwaSubmitted: run.pwaSubmitted,
          submittedByUserId: run.submittedByUserId,
        },
      });
      // Mint an SSE token so the admin can subscribe to propose-channel
      // events immediately.
      const streamToken = app.ctx.streamTokens
        ? app.ctx.streamTokens.mint({
            runId: run.id,
            userId: auth.userId,
            purpose: 'propose',
          })
        : null;
      return reply.code(202).send({ ok: true, streamToken });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-drafts/:id/category — set the procedure
  // category (PM / R&R / Troubleshooting / Walkthrough). Drives the LLM
  // prompt and post-process section grouping. Admins set this on the
  // reviewer page before tapping "Run AI" so the drafter has the right
  // schema in mind. Editable at any point before execute, since the
  // category influences how the executor groups steps.
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: { procedureCategory: z.infer<typeof ProcedureCategorySchema> | null };
  }>(
    '/admin/procedure-drafts/:id/category',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          procedureCategory: ProcedureCategorySchema.nullable(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      if (run.status === 'completed' || run.status === 'cancelled') {
        return reply.conflict(
          `cannot change category in terminal status '${run.status}'`,
        );
      }
      await db
        .update(schema.procedureDraftRuns)
        .set({
          procedureCategory: request.body.procedureCategory,
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureDraftRuns.id, run.id));
      // If the executor has already materialized a document for this
      // draft, mirror the category onto it so the PWA's Maintenance tab
      // re-buckets immediately. Without this, an admin who changes the
      // category after promotion would update only the draft run row
      // and the published procedure would stay in its original bucket.
      if (run.targetDocumentId) {
        const targetDoc = await db.query.documents.findFirst({
          where: eq(schema.documents.id, run.targetDocumentId),
          columns: { procedureMetadata: true },
        });
        const nextMetadata = {
          ...(targetDoc?.procedureMetadata ?? {
            toolsRequired: { common: [], special: [], consumables: [] },
            safety: { enabled: false, notes: null },
            verification: { enabled: false, notes: null },
          }),
          category: request.body.procedureCategory,
        };
        await db
          .update(schema.documents)
          .set({ procedureMetadata: nextMetadata })
          .where(eq(schema.documents.id, run.targetDocumentId));
      }
      await recordAudit(db, request, {
        organizationId: run.ownerOrganizationId,
        eventType: 'procedure_draft.category_set',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: { procedureCategory: request.body.procedureCategory },
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/procedure-drafts/:id/refresh-mux — manual webhook recovery
  //
  // When Mux webhooks don't land (destination misconfigured, network
  // blip, the run was created against a different env, etc.), the
  // draft stays in 'uploading' forever. This route polls Mux directly
  // and advances state based on the upload/asset status it returns.
  // Idempotent and safe to call repeatedly.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/procedure-drafts/:id/refresh-mux',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const run = await loadRun(db, request.params.id);
      if (!run) return reply.notFound();
      requireDraftAccess(run, scope);
      try {
        const result = await refreshDraftFromMux(app, run.id);
        return reply.send(result);
      } catch (err) {
        return reply.internalServerError(
          err instanceof Error ? err.message : String(err),
        );
      }
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
      await recordAudit(db, request, {
        organizationId: run.ownerOrganizationId,
        eventType: 'procedure_draft.cancelled',
        targetType: 'procedure_draft_run',
        targetId: run.id,
        payload: {},
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
