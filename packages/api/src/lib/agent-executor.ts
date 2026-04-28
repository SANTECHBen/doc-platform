// API-side wiring of the agent executor.
//
// Implements `AdminClient` against Postgres + S3 + Mux, calls the pure
// `executeProposal` function from @platform/ai, persists the per-step
// idempotency ledger to `agent_execution_steps`, writes audit events,
// and broadcasts SSE progress.
//
// Idempotency:
//   - Each plan node maps to one execution_step row (unique on
//     (execution_id, client_token)).
//   - Before applying a node we check the ledger; succeeded /
//     skipped_existing rows are skipped on resume.
//   - Natural-key dedup against the live tables guards against duplicate
//     creates even when the ledger is fresh.

import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { schema, type Database } from '@platform/db';
import {
  ProposalTreeSchema,
  executeProposal,
  type AdminClient,
  type StepRecord,
  type ProposalTree,
} from '@platform/ai';
import type { FastifyInstance } from 'fastify';
import { agentBus, runChannel } from './agent-bus.js';

const QR_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
function newQrCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += QR_ALPHABET[bytes[i]! % QR_ALPHABET.length];
  }
  return out;
}

interface RunExecuteParams {
  app: FastifyInstance;
  executionId: string;
}

export async function runExecutePhase({ app, executionId }: RunExecuteParams): Promise<void> {
  const { db } = app.ctx;

  const execution = await db.query.agentExecutions.findFirst({
    where: eq(schema.agentExecutions.id, executionId),
  });
  if (!execution) throw new Error(`Execution not found: ${executionId}`);

  const proposal = await db.query.agentProposals.findFirst({
    where: eq(schema.agentProposals.id, execution.proposalId),
  });
  if (!proposal) throw new Error(`Proposal not found: ${execution.proposalId}`);

  const run = await db.query.agentRuns.findFirst({
    where: eq(schema.agentRuns.id, proposal.runId),
  });
  if (!run) throw new Error(`Run not found: ${proposal.runId}`);

  const channel = runChannel(run.id, 'execute');
  agentBus.publish(channel, 'status', { status: 'executing', executionId });

  const treeResult = ProposalTreeSchema.safeParse(proposal.content);
  if (!treeResult.success) {
    const errMsg = `Proposal content failed validation: ${treeResult.error.message}`;
    await markExecutionFailed(db, executionId, errMsg);
    await markRunFailed(db, run.id, errMsg);
    agentBus.publish(channel, 'error', { message: errMsg });
    agentBus.publish(channel, 'done', { ok: false });
    agentBus.close(channel);
    return;
  }

  // Pre-load the existing ledger for resume.
  const priorSteps = await db.query.agentExecutionSteps.findMany({
    where: eq(schema.agentExecutionSteps.executionId, executionId),
  });
  const priorByToken = new Map<string, typeof priorSteps[number]>();
  for (const s of priorSteps) priorByToken.set(s.clientToken, s);

  // Pre-fetch run files keyed by relative path for source resolution.
  type RunFileRow = typeof schema.agentRunFiles.$inferSelect;
  const files = (await db.query.agentRunFiles.findMany({
    where: eq(schema.agentRunFiles.runId, run.id),
  })) as RunFileRow[];
  const filesByPath = new Map<string, RunFileRow>(
    files.map((f) => [f.relativePath, f]),
  );

  const adminClient = buildAdminClient({
    app,
    actorUserId: execution.startedByUserId,
    runId: run.id,
    filesByPath,
  });

  let lastError: string | null = null;
  try {
    const result = await executeProposal({
      proposalId: proposal.id,
      tree: treeResult.data,
      client: adminClient,
      ledger: (token) => {
        const row = priorByToken.get(token);
        if (!row) return null;
        return {
          clientToken: row.clientToken,
          kind: row.stepType,
          // clientId isn't on the row directly; reconstruct from token suffix.
          clientId: token.split(':').pop() ?? '',
          status: row.status,
          targetId: row.targetId,
          notes: row.notes,
          error: row.error,
        } as StepRecord;
      },
      onStep: async (step) => {
        await persistStep(db, executionId, step);
        agentBus.publish(channel, 'execution_step', {
          clientToken: step.clientToken,
          kind: step.kind,
          clientId: step.clientId,
          status: step.status,
          targetId: step.targetId,
          notes: step.notes,
          error: step.error,
        });
        // Audit event for terminal states.
        if (step.status === 'succeeded' || step.status === 'skipped_existing') {
          await writeAudit(db, run, execution.startedByUserId, step, treeResult.data);
        }
      },
    });

    const finalStatus = result.stepsFailed === 0 ? 'succeeded' : 'partial';
    await db
      .update(schema.agentExecutions)
      .set({ status: finalStatus, finishedAt: new Date() })
      .where(eq(schema.agentExecutions.id, executionId));
    await db
      .update(schema.agentRuns)
      .set({
        status: finalStatus === 'succeeded' ? 'completed' : 'awaiting_review',
        updatedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, run.id));

    agentBus.publish(channel, 'done', {
      ok: finalStatus === 'succeeded',
      stepsAttempted: result.stepsAttempted,
      stepsSucceeded: result.stepsSucceeded,
      stepsSkipped: result.stepsSkipped,
      stepsFailed: result.stepsFailed,
    });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    app.log.error({ err, executionId }, 'agent executor threw');
    await markExecutionFailed(db, executionId, lastError);
    await markRunFailed(db, run.id, lastError);
    agentBus.publish(channel, 'error', { message: lastError });
    agentBus.publish(channel, 'done', { ok: false });
  } finally {
    agentBus.close(channel);
  }
}

// ---------------------------------------------------------------------------
// AdminClient factory — direct DB writes
// ---------------------------------------------------------------------------

interface BuildAdminClientArgs {
  app: FastifyInstance;
  actorUserId: string;
  runId: string;
  filesByPath: Map<string, typeof schema.agentRunFiles.$inferSelect>;
}

function buildAdminClient(args: BuildAdminClientArgs): AdminClient {
  const { app, filesByPath } = args;
  const { db } = app.ctx;

  return {
    async resolveSource(relativePath) {
      const f = filesByPath.get(relativePath);
      if (!f) return null;
      return {
        storageKey: f.storageKey,
        streamPlaybackId: f.streamPlaybackId,
        contentType: f.contentType,
        sizeBytes: f.size,
        originalFilename: relativePath.split('/').pop() ?? null,
      };
    },

    async findOrganization({ name, parentId, oemCode }) {
      // Prefer oemCode (exact, OEM-only) when present.
      if (oemCode) {
        const row = await db.query.organizations.findFirst({
          where: eq(schema.organizations.oemCode, oemCode),
        });
        if (row) return { id: row.id };
      }
      const conds = [eq(schema.organizations.name, name)];
      if (parentId) {
        conds.push(eq(schema.organizations.parentOrganizationId, parentId));
      }
      const row = await db.query.organizations.findFirst({
        where: and(...conds),
      });
      return row ? { id: row.id } : null;
    },
    async findSite({ organizationId, name }) {
      const row = await db.query.sites.findFirst({
        where: and(
          eq(schema.sites.organizationId, organizationId),
          eq(schema.sites.name, name),
        ),
      });
      return row ? { id: row.id } : null;
    },
    async findAssetModel({ ownerOrganizationId, modelCode }) {
      const row = await db.query.assetModels.findFirst({
        where: and(
          eq(schema.assetModels.ownerOrganizationId, ownerOrganizationId),
          eq(schema.assetModels.modelCode, modelCode),
        ),
      });
      return row ? { id: row.id } : null;
    },
    async findPart({ ownerOrganizationId, oemPartNumber }) {
      const row = await db.query.parts.findFirst({
        where: and(
          eq(schema.parts.ownerOrganizationId, ownerOrganizationId),
          eq(schema.parts.oemPartNumber, oemPartNumber),
        ),
      });
      return row ? { id: row.id } : null;
    },
    async findContentPack({ slug }) {
      const row = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.slug, slug),
      });
      return row ? { id: row.id } : null;
    },
    async findAssetInstance({ assetModelId, serialNumber }) {
      const row = await db.query.assetInstances.findFirst({
        where: and(
          eq(schema.assetInstances.assetModelId, assetModelId),
          eq(schema.assetInstances.serialNumber, serialNumber),
        ),
      });
      return row ? { id: row.id } : null;
    },
    async findBomEntry({ assetModelId, partId }) {
      const row = await db.query.bomEntries.findFirst({
        where: and(
          eq(schema.bomEntries.assetModelId, assetModelId),
          eq(schema.bomEntries.partId, partId),
        ),
      });
      return row ? { id: row.id } : null;
    },
    async findQrCodeForInstance({ assetInstanceId }) {
      const row = await db.query.qrCodes.findFirst({
        where: eq(schema.qrCodes.assetInstanceId, assetInstanceId),
      });
      return row ? { id: row.id } : null;
    },

    // ---- creates --------------------------------------------------------

    async createOrganization(input) {
      const [created] = await db
        .insert(schema.organizations)
        .values({
          type: input.type,
          name: input.name,
          slug: input.slug,
          parentOrganizationId: input.parentOrganizationId,
          oemCode: input.oemCode,
          brandPrimary: input.brandPrimary,
          brandOnPrimary: input.brandOnPrimary,
          logoStorageKey: input.logoStorageKey,
          displayNameOverride: input.displayNameOverride,
        })
        .returning();
      if (!created) throw new Error('createOrganization failed');
      return { id: created.id };
    },
    async createSite(input) {
      const [created] = await db
        .insert(schema.sites)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          code: input.code,
          city: input.city,
          region: input.region,
          country: input.country,
          postalCode: input.postalCode,
          timezone: input.timezone ?? 'UTC',
        })
        .returning();
      if (!created) throw new Error('createSite failed');
      return { id: created.id };
    },
    async createAssetModel(input) {
      const [created] = await db
        .insert(schema.assetModels)
        .values({
          ownerOrganizationId: input.ownerOrganizationId,
          modelCode: input.modelCode,
          displayName: input.displayName,
          category: input.category,
          description: input.description,
          imageStorageKey: input.heroStorageKey,
        })
        .returning();
      if (!created) throw new Error('createAssetModel failed');
      return { id: created.id };
    },
    async createPart(input) {
      const [created] = await db
        .insert(schema.parts)
        .values({
          ownerOrganizationId: input.ownerOrganizationId,
          oemPartNumber: input.oemPartNumber,
          displayName: input.displayName,
          description: input.description,
          crossReferences: input.crossReferences,
          imageStorageKey: input.imageStorageKey,
        })
        .returning();
      if (!created) throw new Error('createPart failed');
      return { id: created.id };
    },
    async createBomEntry(input) {
      const [created] = await db
        .insert(schema.bomEntries)
        .values({
          assetModelId: input.assetModelId,
          partId: input.partId,
          positionRef: input.positionRef,
          quantity: input.quantity,
          notes: input.notes,
        })
        .returning();
      if (!created) throw new Error('createBomEntry failed');
      return { id: created.id };
    },
    async createContentPack(input) {
      // Look up the model to get the owner org (the schema requires it).
      const model = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, input.assetModelId),
      });
      if (!model) throw new Error('Asset model not found for content pack');
      return await db.transaction(async (tx: Database) => {
        const [pack] = await tx
          .insert(schema.contentPacks)
          .values({
            assetModelId: input.assetModelId,
            ownerOrganizationId: model.ownerOrganizationId,
            layerType: input.layerType,
            name: input.name,
            slug: input.slug,
            basePackId: input.basePackId,
          })
          .returning();
        if (!pack) throw new Error('createContentPack failed');
        const [draftVersion] = await tx
          .insert(schema.contentPackVersions)
          .values({
            contentPackId: pack.id,
            versionNumber: 1,
            versionLabel: '1.0',
            status: 'draft',
          })
          .returning();
        if (!draftVersion) throw new Error('failed to create draft version');
        return { id: pack.id, draftVersionId: draftVersion.id };
      });
    },
    async createContentPackVersion(input) {
      // Compute next version number.
      const last = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.contentPackId, input.contentPackId),
        orderBy: (
          t: typeof schema.contentPackVersions,
          h: { desc: (col: unknown) => unknown },
        ) => [h.desc(t.versionNumber)],
      });
      const nextVersionNumber = (last?.versionNumber ?? 0) + 1;
      const [created] = await db
        .insert(schema.contentPackVersions)
        .values({
          contentPackId: input.contentPackId,
          versionNumber: nextVersionNumber,
          versionLabel: input.versionLabel,
          changelog: input.changelog,
          status: 'draft',
        })
        .returning();
      if (!created) throw new Error('createContentPackVersion failed');
      return { id: created.id };
    },
    async createDocument(input) {
      const [created] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: input.contentPackVersionId,
          kind: input.kind,
          title: input.title,
          language: input.language,
          safetyCritical: input.safetyCritical,
          tags: input.tags,
          bodyMarkdown: input.bodyMarkdown,
          storageKey: input.storageKey,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          originalFilename: input.originalFilename,
          externalUrl: input.externalUrl,
          streamPlaybackId: input.streamPlaybackId,
          thumbnailStorageKey: input.thumbnailStorageKey,
          // Set extraction status appropriately for the kind.
          extractionStatus:
            input.kind === 'pdf' || input.kind === 'slides' || input.kind === 'schematic'
              ? 'pending'
              : 'not_applicable',
        })
        .returning();
      if (!created) throw new Error('createDocument failed');
      return { id: created.id };
    },
    async createTrainingModule(input) {
      const [created] = await db
        .insert(schema.trainingModules)
        .values({
          contentPackVersionId: input.contentPackVersionId,
          title: input.title,
          description: input.description,
          estimatedMinutes: input.estimatedMinutes,
          competencyTag: input.competencyTag,
          passThreshold: input.passThreshold ?? 0.8,
        })
        .returning();
      if (!created) throw new Error('createTrainingModule failed');
      return { id: created.id };
    },
    async createLesson(input) {
      const [created] = await db
        .insert(schema.lessons)
        .values({
          trainingModuleId: input.trainingModuleId,
          title: input.title,
          bodyMarkdown: input.bodyMarkdown,
        })
        .returning();
      if (!created) throw new Error('createLesson failed');
      // Link supplied documents (best-effort; partTrainingModules is a
      // different relation — for lessons we don't have a direct doc link
      // table in the current schema. The bodyMarkdown could embed them.
      // For v1 this is OK; future work: add a lesson_documents join table.
      return { id: created.id };
    },
    async createAssetInstance(input) {
      const [created] = await db
        .insert(schema.assetInstances)
        .values({
          assetModelId: input.assetModelId,
          siteId: input.siteId,
          serialNumber: input.serialNumber,
          installedAt: input.installedAt ? new Date(input.installedAt) : null,
          pinnedContentPackVersionId: input.pinnedContentPackVersionId,
        })
        .returning();
      if (!created) throw new Error('createAssetInstance failed');
      return { id: created.id };
    },
    async mintQrCode(input) {
      // Try a few times in case of unique-collision on `code`.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newQrCode();
        try {
          const [created] = await db
            .insert(schema.qrCodes)
            .values({
              code,
              assetInstanceId: input.assetInstanceId,
              label: input.label,
              preferredTemplateId: input.preferredTemplateId,
              active: true,
            })
            .returning();
          if (created) return { id: created.id };
        } catch (err) {
          // unique violation on code; retry
          if (attempt === 4) throw err;
        }
      }
      throw new Error('mintQrCode: exhausted retries');
    },
    async publishContentPackVersion({ versionId }) {
      const [updated] = await db
        .update(schema.contentPackVersions)
        .set({
          status: 'published',
          publishedAt: new Date(),
          publishedBy: args.actorUserId,
        })
        .where(eq(schema.contentPackVersions.id, versionId))
        .returning();
      if (!updated) throw new Error('publishContentPackVersion failed');
      return { id: updated.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function persistStep(
  db: Database,
  executionId: string,
  step: StepRecord,
): Promise<void> {
  await db
    .insert(schema.agentExecutionSteps)
    .values({
      executionId,
      clientToken: step.clientToken,
      stepType: step.kind,
      targetId: step.targetId,
      status: step.status,
      notes: step.notes,
      error: step.error,
      startedAt: step.status === 'in_progress' ? new Date() : null,
      finishedAt:
        step.status === 'succeeded' ||
        step.status === 'skipped_existing' ||
        step.status === 'failed'
          ? new Date()
          : null,
    })
    .onConflictDoUpdate({
      target: [
        schema.agentExecutionSteps.executionId,
        schema.agentExecutionSteps.clientToken,
      ],
      set: {
        stepType: step.kind,
        targetId: step.targetId,
        status: step.status,
        notes: step.notes,
        error: step.error,
        finishedAt:
          step.status === 'succeeded' ||
          step.status === 'skipped_existing' ||
          step.status === 'failed'
            ? new Date()
            : null,
      },
    });
}

async function writeAudit(
  db: Database,
  run: typeof schema.agentRuns.$inferSelect,
  actorUserId: string,
  step: StepRecord,
  tree: ProposalTree,
): Promise<void> {
  // For org-scoped audits, the run's targetOrganizationId may be null at
  // first; once an organization step succeeds we set it.
  let orgId = run.targetOrganizationId;
  if (!orgId && step.kind === 'organization' && step.targetId) {
    orgId = step.targetId;
    await db
      .update(schema.agentRuns)
      .set({ targetOrganizationId: step.targetId, updatedAt: new Date() })
      .where(eq(schema.agentRuns.id, run.id));
  }
  if (!orgId) return; // can't write a scoped audit yet

  const node = tree.nodes.find((n) => n.clientId === step.clientId);
  await db.insert(schema.auditEvents).values({
    organizationId: orgId,
    actorUserId,
    eventType: `agent.${step.kind}.${step.status}`,
    targetType: step.kind,
    targetId: step.targetId,
    payload: {
      runId: run.id,
      clientId: step.clientId,
      notes: step.notes,
      confidence: node?.confidence ?? null,
      fromConvention: node?.fromConvention ?? null,
    },
  });
}

async function markExecutionFailed(
  db: Database,
  executionId: string,
  error: string,
): Promise<void> {
  await db
    .update(schema.agentExecutions)
    .set({ status: 'failed', error, finishedAt: new Date() })
    .where(eq(schema.agentExecutions.id, executionId));
}

async function markRunFailed(db: Database, runId: string, error: string): Promise<void> {
  await db
    .update(schema.agentRuns)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(eq(schema.agentRuns.id, runId));
}
