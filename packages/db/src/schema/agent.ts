import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { organizations } from './organizations';

// Onboarding Agent runtime state.
//
// The agent ingests a local folder (selected via the browser File System Access
// API), produces a structured proposal of orgs/sites/asset models/parts/content
// packs/etc., and then — after the admin reviews it — idempotently applies that
// proposal against the rest of the system.
//
// Five tables: runs (top-level lifecycle), run_files (uploaded artifact rows),
// proposals (the LLM's structured output), executions (apply attempts),
// execution_steps (the per-node idempotency ledger).
//
// Enum values are stored as plain text + check constraints rather than pg enums
// so we can evolve states without migrations.

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------

export type AgentRunStatus =
  | 'scanning'
  | 'uploading'
  | 'proposing'
  | 'awaiting_review'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentManifestEntry {
  relativePath: string;
  size: number;
  contentType: string | null;
  // Browser-supplied; server still computes sha256 server-side at upload.
  lastModified: number | null;
}

export interface AgentManifest {
  rootName: string;
  totalFiles: number;
  totalBytes: number;
  entries: AgentManifestEntry[];
}

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Set after the first organization node executes successfully. Used to
    // scope subsequent audit events.
    targetOrganizationId: uuid('target_organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    status: text('status').$type<AgentRunStatus>().notNull().default('scanning'),
    manifest: jsonb('manifest').$type<AgentManifest | null>(),
    // Output of the deterministic convention parser. Free-form because the
    // parser evolves; the agent loop reads it as priming context.
    conventionHits: jsonb('convention_hits').$type<Record<string, unknown> | null>(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    creatorTimeIdx: index('agent_runs_creator_time_idx').on(t.createdByUserId, t.createdAt),
    statusIdx: index('agent_runs_status_idx').on(t.status),
  }),
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;

// ---------------------------------------------------------------------------
// agent_run_files
// ---------------------------------------------------------------------------

export type AgentRunFileStatus =
  | 'pending'
  | 'uploaded'
  | 'mux_processing'
  | 'ready'
  | 'failed';

export const agentRunFiles = pgTable(
  'agent_run_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull(),
    sha256: text('sha256'),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type'),
    // S3 storage key for non-video uploads. NULL for videos (Mux path).
    storageKey: text('storage_key'),
    // Mux Direct Upload identifier (returned by mux.video.uploads.create).
    muxUploadId: text('mux_upload_id'),
    // Mux asset id (set on `video.upload.asset_created` webhook).
    muxAssetId: text('mux_asset_id'),
    // Mux playback id (set on `video.asset.ready` webhook). Persists onto the
    // document row at execute time.
    streamPlaybackId: text('stream_playback_id'),
    status: text('status').$type<AgentRunFileStatus>().notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runPathUniq: unique('agent_run_files_run_path_uniq').on(t.runId, t.relativePath),
    runStatusIdx: index('agent_run_files_run_status_idx').on(t.runId, t.status),
    muxUploadIdx: index('agent_run_files_mux_upload_idx').on(t.muxUploadId),
  }),
);

export type AgentRunFile = typeof agentRunFiles.$inferSelect;
export type NewAgentRunFile = typeof agentRunFiles.$inferInsert;

// ---------------------------------------------------------------------------
// agent_proposals
// ---------------------------------------------------------------------------
//
// The proposal `content` is a tree of typed plan nodes (see
// packages/ai/src/agent/schema.ts). Validated against a Zod schema before
// it lands here; if the LLM emits invalid nodes they're rejected at the
// route layer and never persisted.

export interface ProposalTokenUsage {
  inputTokens: number;
  outputTokens: number;
  // Total cost in USD if the gateway returns it — informational only.
  costUsd?: number;
}

export const agentProposals = pgTable(
  'agent_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    // Optimistic concurrency control: PATCH increments this and clients send
    // the version they read. Stale writes get a 409.
    version: integer('version').notNull().default(1),
    content: jsonb('content').$type<unknown>().notNull(),
    summary: text('summary'),
    modelUsed: text('model_used'),
    tokenUsage: jsonb('token_usage').$type<ProposalTokenUsage | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runUniq: unique('agent_proposals_run_uniq').on(t.runId),
  }),
);

export type AgentProposal = typeof agentProposals.$inferSelect;
export type NewAgentProposal = typeof agentProposals.$inferInsert;

// ---------------------------------------------------------------------------
// agent_executions
// ---------------------------------------------------------------------------

export type AgentExecutionStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed';

export const agentExecutions = pgTable(
  'agent_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => agentProposals.id, { onDelete: 'cascade' }),
    // Snapshot of agent_proposals.version at execute time. Used to detect
    // mid-flight edits.
    proposalVersion: integer('proposal_version').notNull(),
    startedByUserId: uuid('started_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').$type<AgentExecutionStatus>().notNull().default('running'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    proposalIdx: index('agent_executions_proposal_idx').on(t.proposalId),
    statusIdx: index('agent_executions_status_idx').on(t.status),
  }),
);

export type AgentExecution = typeof agentExecutions.$inferSelect;
export type NewAgentExecution = typeof agentExecutions.$inferInsert;

// ---------------------------------------------------------------------------
// agent_execution_steps — the per-node idempotency ledger
// ---------------------------------------------------------------------------

export type AgentExecutionStepStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'skipped_existing'
  | 'failed';

// Stays in sync with proposal node kinds (packages/ai/src/agent/schema.ts).
export type AgentExecutionStepType =
  | 'organization'
  | 'site'
  | 'asset_model'
  | 'part'
  | 'bom_entry'
  | 'content_pack'
  | 'content_pack_version'
  | 'document'
  | 'training_module'
  | 'lesson'
  | 'asset_instance'
  | 'qr_code'
  | 'publish_version';

export const agentExecutionSteps = pgTable(
  'agent_execution_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => agentExecutions.id, { onDelete: 'cascade' }),
    // Stable token derived from proposalId + nodeKind + clientId. Survives
    // admin edits and re-runs. Format: agent:<proposalId>:<kind>:<clientId>
    clientToken: text('client_token').notNull(),
    stepType: text('step_type').$type<AgentExecutionStepType>().notNull(),
    // Filled in once the step succeeds (or finds an existing match). NULL
    // until then.
    targetId: uuid('target_id'),
    status: text('status').$type<AgentExecutionStepStatus>().notNull().default('pending'),
    error: text('error'),
    // Free-form rationale for humans reading the audit trail (e.g. "matched
    // existing org by oem_code", "created").
    notes: text('notes'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    execTokenUniq: unique('agent_execution_steps_exec_token_uniq').on(
      t.executionId,
      t.clientToken,
    ),
    execStatusIdx: index('agent_execution_steps_exec_status_idx').on(
      t.executionId,
      t.status,
    ),
  }),
);

export type AgentExecutionStep = typeof agentExecutionSteps.$inferSelect;
export type NewAgentExecutionStep = typeof agentExecutionSteps.$inferInsert;

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [agentRuns.createdByUserId],
    references: [users.id],
  }),
  targetOrganization: one(organizations, {
    fields: [agentRuns.targetOrganizationId],
    references: [organizations.id],
  }),
  files: many(agentRunFiles),
  proposal: one(agentProposals, {
    fields: [agentRuns.id],
    references: [agentProposals.runId],
  }),
}));

export const agentRunFilesRelations = relations(agentRunFiles, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunFiles.runId],
    references: [agentRuns.id],
  }),
}));

export const agentProposalsRelations = relations(agentProposals, ({ one, many }) => ({
  run: one(agentRuns, {
    fields: [agentProposals.runId],
    references: [agentRuns.id],
  }),
  executions: many(agentExecutions),
}));

export const agentExecutionsRelations = relations(agentExecutions, ({ one, many }) => ({
  proposal: one(agentProposals, {
    fields: [agentExecutions.proposalId],
    references: [agentProposals.id],
  }),
  startedBy: one(users, {
    fields: [agentExecutions.startedByUserId],
    references: [users.id],
  }),
  steps: many(agentExecutionSteps),
}));

export const agentExecutionStepsRelations = relations(agentExecutionSteps, ({ one }) => ({
  execution: one(agentExecutions, {
    fields: [agentExecutionSteps.executionId],
    references: [agentExecutions.id],
  }),
}));
