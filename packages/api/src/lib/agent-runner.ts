// Wires the @platform/ai agent loop to the API's DB / storage / Mux clients.
//
// The route handler calls runProposePhase(app, runId). This function:
//   1. Loads the run, manifest, scaffold, and uploaded run files.
//   2. Builds an AgentToolContext that proxies to Postgres, S3 storage, the
//      AI Gateway vision endpoint, and the Mux client.
//   3. Updates the run status to `proposing`.
//   4. Calls runAgentLoop.
//   5. Persists final state — `awaiting_review` on success, `failed` on error.
//
// All event broadcasting goes through `agentBus.publish` on the propose
// channel. The SSE GET endpoint subscribes to that channel.
//
// Idempotent: callers can re-run if it crashes. The agent_proposals row is
// upserted; nodes are merged by clientId (later wins).

import { and, eq, ilike, or } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import {
  parseConvention,
  runAgentLoop,
  createGatewayImageClassifier,
  ProposalTreeSchema,
  validateReferences,
  type Manifest,
  type ProposalNode,
  type ProposalTree,
  type ScaffoldTree,
  type AgentLoopResult,
  type AgentToolContext,
} from '@platform/ai';
import type { FastifyInstance } from 'fastify';
import { readStorageBuffer } from './storage-buffer.js';
import { agentBus, runChannel } from './agent-bus.js';

interface ProposePhaseParams {
  app: FastifyInstance;
  runId: string;
}

export async function runProposePhase({ app, runId }: ProposePhaseParams): Promise<void> {
  const channel = runChannel(runId, 'propose');
  const { db, storage, env } = app.ctx;

  await db
    .update(schema.agentRuns)
    .set({ status: 'proposing', updatedAt: new Date(), error: null })
    .where(eq(schema.agentRuns.id, runId));
  agentBus.publish(channel, 'status', { status: 'proposing' });

  let result: AgentLoopResult | null = null;
  let lastError: string | null = null;

  try {
    const run = await db.query.agentRuns.findFirst({
      where: eq(schema.agentRuns.id, runId),
    });
    if (!run) throw new Error(`Agent run not found: ${runId}`);
    if (!run.manifest) throw new Error('Manifest missing on run; cannot propose');

    const manifest = run.manifest as Manifest;
    const runFiles = await db.query.agentRunFiles.findMany({
      where: eq(schema.agentRunFiles.runId, runId),
    });

    // Build the convention scaffold. ConventionContext.readText only needs
    // small files (CSVs, color hex). We resolve those by storage key from
    // the agent_run_files rows.
    type RunFileRow = typeof schema.agentRunFiles.$inferSelect;
    const filesByPath = new Map<string, RunFileRow>(
      (runFiles as RunFileRow[]).map((f) => [f.relativePath, f]),
    );
    const scaffold: ScaffoldTree = await parseConvention(manifest, {
      readText: async (relativePath) => {
        const f = filesByPath.get(relativePath);
        if (!f || !f.storageKey) return null;
        if (f.size > 256 * 1024) return null;
        const buf = await readStorageBuffer(storage, f.storageKey);
        return buf?.toString('utf8') ?? null;
      },
    });

    agentBus.publish(channel, 'status', {
      status: 'scaffold_ready',
      nodeCount: scaffold.nodes.length,
      looseFiles: scaffold.looseFiles.length,
      unmatched: scaffold.unmatched.length,
    });

    // Persist the scaffold as the initial proposal content. The agent loop
    // appends to this via emitNode.
    const initialTree: ProposalTree = ProposalTreeSchema.parse({
      schemaVersion: 1,
      summary: '',
      warnings: scaffold.unmatched.map(
        (u) => `Convention parser: ${u.relativePath} — ${u.reason}`,
      ),
      nodes: scaffold.nodes,
    });

    // Upsert the proposal row.
    const proposalId = await upsertProposal(db, runId, initialTree);

    // Pre-fetch existing OEMs that match the scaffold orgs (dedup hint).
    const oemSlugs = scaffold.nodes
      .filter((n): n is Extract<ProposalNode, { kind: 'organization' }> => n.kind === 'organization')
      .map((n) => n.payload.name);
    type OrgRow = typeof schema.organizations.$inferSelect;
    const existingOrgs: OrgRow[] = oemSlugs.length
      ? await db.query.organizations.findMany({
          where: or(
            ...oemSlugs.map((name) => ilike(schema.organizations.name, name)),
          ),
        })
      : [];

    const ctx = buildToolContext({
      app,
      runId,
      proposalId,
      filesByPath,
      channel,
    });

    result = await runAgentLoop({
      ctx,
      manifest,
      scaffold,
      existingEntities: {
        organizations: existingOrgs.map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type as string,
          oemCode: o.oemCode,
        })),
      },
      model: env.AGENT_MODEL,
    });

    // Persist token usage, model.
    if (result.usage) {
      await db
        .update(schema.agentProposals)
        .set({
          modelUsed: result.modelUsed,
          tokenUsage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
          updatedAt: new Date(),
        })
        .where(eq(schema.agentProposals.id, proposalId));
    }

    // Final defensive validation of the proposal references.
    const proposalNow = await db.query.agentProposals.findFirst({
      where: eq(schema.agentProposals.id, proposalId),
    });
    if (proposalNow) {
      const parsed = ProposalTreeSchema.safeParse(proposalNow.content);
      if (parsed.success) {
        const refCheck = validateReferences(parsed.data);
        if (!refCheck.ok) {
          for (const err of refCheck.errors) {
            agentBus.publish(channel, 'warning', { message: err });
          }
        }
      }
    }

    if (result.reason === 'finish' || result.finalized) {
      await db
        .update(schema.agentRuns)
        .set({ status: 'awaiting_review', updatedAt: new Date() })
        .where(eq(schema.agentRuns.id, runId));
      agentBus.publish(channel, 'status', {
        status: 'awaiting_review',
        finalized: result.finalized,
        steps: result.steps,
      });
    } else {
      lastError = result.error ?? `loop ended with reason ${result.reason}`;
      await db
        .update(schema.agentRuns)
        .set({ status: 'failed', error: lastError, updatedAt: new Date() })
        .where(eq(schema.agentRuns.id, runId));
      agentBus.publish(channel, 'error', { message: lastError });
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    app.log.error({ err, runId }, 'agent propose phase threw');
    await db
      .update(schema.agentRuns)
      .set({ status: 'failed', error: lastError, updatedAt: new Date() })
      .where(eq(schema.agentRuns.id, runId));
    agentBus.publish(channel, 'error', { message: lastError });
  } finally {
    agentBus.publish(channel, 'done', {
      ok: !lastError,
      steps: result?.steps ?? 0,
      tokenUsage: result?.usage ?? null,
    });
    agentBus.close(channel);
  }
}

// ---------------------------------------------------------------------------
// AgentToolContext factory
// ---------------------------------------------------------------------------

interface BuildContextArgs {
  app: FastifyInstance;
  runId: string;
  proposalId: string;
  filesByPath: Map<string, typeof schema.agentRunFiles.$inferSelect>;
  channel: string;
}

function buildToolContext(args: BuildContextArgs): AgentToolContext {
  const { app, runId, proposalId, filesByPath, channel } = args;
  const { db, storage, mux, env } = app.ctx;

  return {
    db,
    readFile: async (relativePath) => {
      const f = filesByPath.get(relativePath);
      if (!f || !f.storageKey) return null;
      return readStorageBuffer(storage, f.storageKey);
    },
    statFile: async (relativePath) => {
      const f = filesByPath.get(relativePath);
      if (!f) return null;
      return { sizeBytes: f.size, contentType: f.contentType };
    },
    searchOrganizations: async (params) => {
      const filters = [];
      if (params.name) filters.push(ilike(schema.organizations.name, `%${params.name}%`));
      if (params.oemCode) filters.push(eq(schema.organizations.oemCode, params.oemCode));
      if (params.type) filters.push(eq(schema.organizations.type, params.type as 'oem' | 'dealer' | 'integrator' | 'end_customer'));
      if (filters.length === 0) return [];
      const rows = await db
        .select()
        .from(schema.organizations)
        .where(and(...filters))
        .limit(10);
      return (rows as Array<typeof schema.organizations.$inferSelect>).map((o) => ({
        id: o.id,
        name: o.name,
        type: o.type as string,
        oemCode: o.oemCode,
        parentId: o.parentOrganizationId,
      }));
    },
    searchAssetModels: async (params) => {
      const filters = [];
      if (params.ownerOrgId) filters.push(eq(schema.assetModels.ownerOrganizationId, params.ownerOrgId));
      if (params.modelCode) filters.push(eq(schema.assetModels.modelCode, params.modelCode));
      if (params.displayName) filters.push(ilike(schema.assetModels.displayName, `%${params.displayName}%`));
      if (filters.length === 0) return [];
      const rows = await db
        .select()
        .from(schema.assetModels)
        .where(and(...filters))
        .limit(10);
      return (rows as Array<typeof schema.assetModels.$inferSelect>).map((m) => ({
        id: m.id,
        ownerOrgId: m.ownerOrganizationId,
        modelCode: m.modelCode,
        displayName: m.displayName,
      }));
    },
    searchParts: async (params) => {
      const filters = [];
      if (params.ownerOrgId) filters.push(eq(schema.parts.ownerOrganizationId, params.ownerOrgId));
      if (params.partNumber) filters.push(eq(schema.parts.oemPartNumber, params.partNumber));
      if (params.name) filters.push(ilike(schema.parts.displayName, `%${params.name}%`));
      if (filters.length === 0) return [];
      const rows = await db
        .select()
        .from(schema.parts)
        .where(and(...filters))
        .limit(20);
      return (rows as Array<typeof schema.parts.$inferSelect>).map((p) => ({
        id: p.id,
        ownerOrgId: p.ownerOrganizationId,
        oemPartNumber: p.oemPartNumber,
        displayName: p.displayName,
      }));
    },
    searchContentPacks: async (params) => {
      const filters = [];
      if (params.assetModelId) filters.push(eq(schema.contentPacks.assetModelId, params.assetModelId));
      if (params.slug) filters.push(eq(schema.contentPacks.slug, params.slug));
      if (filters.length === 0) return [];
      const rows = await db
        .select()
        .from(schema.contentPacks)
        .where(and(...filters))
        .limit(10);
      return (rows as Array<typeof schema.contentPacks.$inferSelect>).map((p) => ({
        id: p.id,
        assetModelId: p.assetModelId,
        ownerOrgId: p.ownerOrganizationId,
        slug: p.slug,
        layerType: p.layerType as string,
      }));
    },
    createMuxDirectUpload: async ({ runFileId, contentType: _ct }) => {
      if (!mux) {
        throw new Error('Mux not configured (set MUX_TOKEN_ID/SECRET/WEBHOOK_SECRET)');
      }
      const result = await mux.createDirectUpload({ passthrough: runFileId });
      await db
        .update(schema.agentRunFiles)
        .set({ muxUploadId: result.uploadId, updatedAt: new Date() })
        .where(eq(schema.agentRunFiles.id, runFileId));
      return result;
    },
    emitNode: async (node) => {
      await mergeNodeIntoProposal(db, proposalId, node);
    },
    finalize: async ({ summary, warnings }) => {
      await db.transaction(async (tx: Database) => {
        const existing = await tx.query.agentProposals.findFirst({
          where: eq(schema.agentProposals.id, proposalId),
        });
        if (!existing) return;
        const tree = ProposalTreeSchema.safeParse(existing.content);
        if (tree.success) {
          const merged: ProposalTree = {
            ...tree.data,
            summary,
            warnings: [...tree.data.warnings, ...warnings],
          };
          await tx
            .update(schema.agentProposals)
            .set({
              content: merged,
              summary,
              version: existing.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.agentProposals.id, proposalId));
        } else {
          await tx
            .update(schema.agentProposals)
            .set({ summary, updatedAt: new Date() })
            .where(eq(schema.agentProposals.id, proposalId));
        }
      });
    },
    emitEvent: (event) => {
      agentBus.publish(channel, event.type, event.data);
    },
    classifyImage: createGatewayImageClassifier({ model: env.AGENT_MODEL }),
  };
}

// ---------------------------------------------------------------------------
// Proposal upsert / merge
// ---------------------------------------------------------------------------

async function upsertProposal(
  db: Database,
  runId: string,
  initialTree: ProposalTree,
): Promise<string> {
  const existing = await db.query.agentProposals.findFirst({
    where: eq(schema.agentProposals.runId, runId),
  });
  if (existing) {
    await db
      .update(schema.agentProposals)
      .set({
        content: initialTree,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentProposals.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(schema.agentProposals)
    .values({
      runId,
      version: 1,
      content: initialTree,
      summary: '',
    })
    .returning();
  if (!created) throw new Error('Failed to insert proposal');
  return created.id;
}

async function mergeNodeIntoProposal(
  db: Database,
  proposalId: string,
  node: ProposalNode,
): Promise<void> {
  await db.transaction(async (tx: Database) => {
    const row = await tx.query.agentProposals.findFirst({
      where: eq(schema.agentProposals.id, proposalId),
    });
    if (!row) return;
    const parsed = ProposalTreeSchema.safeParse(row.content);
    if (!parsed.success) {
      // Bad data — overwrite with a fresh tree containing just this node.
      await tx
        .update(schema.agentProposals)
        .set({
          content: { schemaVersion: 1, summary: '', warnings: [], nodes: [node] },
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.agentProposals.id, proposalId));
      return;
    }
    const tree = parsed.data;
    const idx = tree.nodes.findIndex((n) => n.clientId === node.clientId);
    if (idx >= 0) {
      // Don't overwrite a convention scaffold node — the agent shouldn't be
      // re-emitting these, but be defensive.
      if (tree.nodes[idx]!.fromConvention) {
        return;
      }
      tree.nodes[idx] = node;
    } else {
      tree.nodes.push(node);
    }
    await tx
      .update(schema.agentProposals)
      .set({
        content: tree,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentProposals.id, proposalId));
  });
}
