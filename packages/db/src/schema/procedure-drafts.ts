import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { contentPackVersions, documents } from './content';
import { users } from './users';

// AI Video-Walkthrough → Procedure Draft.
//
// Lifecycle:
//   uploading → transcribing → storyboarding → proposing →
//   awaiting_review → executing → completed
//
// Reuses the existing Mux Direct Upload flow (createDirectUpload with a
// passthrough field) and the Mux webhook handler. The webhook discriminates
// on `passthrough` prefix — "draft:<runId>" routes to draft-pipeline.ts,
// bare ids route to the onboarding agent as before.
//
// Once the proposal is approved, the executor walks each proposed step:
//   1. Download the Mux thumbnail at the chosen timestamp → S3 (media[]).
//   2. Synthesize TTS-1-HD from the cleaned voiceover text → S3 (audio_*).
//   3. Insert a procedure_steps row with proposed_by_draft_run_id set.
// All three steps are idempotent per (executionId, clientToken).

export const procedureDraftRunStatusEnum = pgEnum(
  'procedure_draft_run_status',
  [
    'uploading',
    'transcribing',
    'storyboarding',
    'proposing',
    'awaiting_review',
    'executing',
    'completed',
    'failed',
    'cancelled',
  ],
);

export const procedureDraftTranscriptSourceEnum = pgEnum(
  'procedure_draft_transcript_source',
  ['mux_captions', 'whisper_fallback', 'manual'],
);

export type ProcedureDraftRunStatus =
  (typeof procedureDraftRunStatusEnum.enumValues)[number];

export const procedureDraftRuns = pgTable(
  'procedure_draft_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    targetContentPackVersionId: uuid('target_content_pack_version_id')
      .notNull()
      .references(() => contentPackVersions.id, { onDelete: 'cascade' }),
    // Set after the executor materializes a document. Lets the reviewer
    // page link back to the created procedure.
    targetDocumentId: uuid('target_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    proposedTitle: text('proposed_title').notNull(),
    status: procedureDraftRunStatusEnum('status').notNull().default('uploading'),
    // Mux fields populated by the webhook as the upload moves through Mux's
    // pipeline. muxUploadId persists across the upload window; once Mux
    // creates an asset, muxAssetId + muxPlaybackId follow.
    muxUploadId: text('mux_upload_id'),
    muxAssetId: text('mux_asset_id'),
    muxPlaybackId: text('mux_playback_id'),
    sourceVideoSizeBytes: bigint('source_video_size_bytes', { mode: 'number' }),
    sourceVideoDurationMs: integer('source_video_duration_ms'),
    // Transcript text + raw VTT. We persist both: VTT carries cue timing
    // for the storyboard prompt; plain text drives downstream summaries.
    sourceTranscript: text('source_transcript'),
    sourceCaptionsVtt: text('source_captions_vtt'),
    transcriptSource: procedureDraftTranscriptSourceEnum('transcript_source'),
    storyboardVttUrl: text('storyboard_vtt_url'),
    // Captures Voyage / OpenAI / Mux costs for the reviewer's cost panel.
    error: text('error'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgTimeIdx: index('procedure_draft_runs_org_idx').on(
      t.ownerOrganizationId,
      t.createdAt,
    ),
    muxUploadIdx: index('procedure_draft_runs_mux_upload_idx').on(t.muxUploadId),
    muxAssetIdx: index('procedure_draft_runs_mux_asset_idx').on(t.muxAssetId),
  }),
);

export interface ProcedureDraftTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export const procedureDraftProposals = pgTable(
  'procedure_draft_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => procedureDraftRuns.id, { onDelete: 'cascade' }),
    // Optimistic-concurrency control. PATCH increments this and clients send
    // the version they read. Stale writes get a 409.
    version: integer('version').notNull().default(1),
    // Validated DraftProposalTree (see packages/ai/src/drafter/schema.ts).
    content: jsonb('content').$type<unknown>().notNull(),
    summary: text('summary'),
    modelUsed: text('model_used'),
    tokenUsage: jsonb('token_usage').$type<ProcedureDraftTokenUsage | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runUniq: unique('procedure_draft_proposals_run_uniq').on(t.runId),
  }),
);

export type ProcedureDraftExecutionStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed';

export const procedureDraftExecutions = pgTable(
  'procedure_draft_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => procedureDraftProposals.id, { onDelete: 'cascade' }),
    proposalVersion: integer('proposal_version').notNull(),
    startedByUserId: uuid('started_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status')
      .$type<ProcedureDraftExecutionStatus>()
      .notNull()
      .default('running'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    proposalIdx: index('procedure_draft_executions_proposal_idx').on(t.proposalId),
    statusIdx: index('procedure_draft_executions_status_idx').on(t.status),
  }),
);

export type ProcedureDraftExecutionStepStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'skipped_existing'
  | 'failed';

export const procedureDraftExecutionSteps = pgTable(
  'procedure_draft_execution_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => procedureDraftExecutions.id, { onDelete: 'cascade' }),
    // Stable token: draft:<proposalId>:step:<clientId>. Survives admin
    // edits and re-runs.
    clientToken: text('client_token').notNull(),
    stepType: text('step_type').notNull(),
    // Set once the procedure_steps row is materialized. NULL until then.
    targetProcedureStepId: uuid('target_procedure_step_id'),
    status: text('status')
      .$type<ProcedureDraftExecutionStepStatus>()
      .notNull()
      .default('pending'),
    error: text('error'),
    notes: text('notes'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    execTokenUniq: unique('procedure_draft_execution_steps_exec_token_uniq').on(
      t.executionId,
      t.clientToken,
    ),
    execStatusIdx: index('procedure_draft_execution_steps_exec_status_idx').on(
      t.executionId,
      t.status,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const procedureDraftRunsRelations = relations(
  procedureDraftRuns,
  ({ one, many }) => ({
    ownerOrganization: one(organizations, {
      fields: [procedureDraftRuns.ownerOrganizationId],
      references: [organizations.id],
    }),
    targetContentPackVersion: one(contentPackVersions, {
      fields: [procedureDraftRuns.targetContentPackVersionId],
      references: [contentPackVersions.id],
    }),
    targetDocument: one(documents, {
      fields: [procedureDraftRuns.targetDocumentId],
      references: [documents.id],
    }),
    createdBy: one(users, {
      fields: [procedureDraftRuns.createdByUserId],
      references: [users.id],
    }),
    proposal: one(procedureDraftProposals, {
      fields: [procedureDraftRuns.id],
      references: [procedureDraftProposals.runId],
    }),
  }),
);

export const procedureDraftProposalsRelations = relations(
  procedureDraftProposals,
  ({ one, many }) => ({
    run: one(procedureDraftRuns, {
      fields: [procedureDraftProposals.runId],
      references: [procedureDraftRuns.id],
    }),
    executions: many(procedureDraftExecutions),
  }),
);

export const procedureDraftExecutionsRelations = relations(
  procedureDraftExecutions,
  ({ one, many }) => ({
    proposal: one(procedureDraftProposals, {
      fields: [procedureDraftExecutions.proposalId],
      references: [procedureDraftProposals.id],
    }),
    startedBy: one(users, {
      fields: [procedureDraftExecutions.startedByUserId],
      references: [users.id],
    }),
    steps: many(procedureDraftExecutionSteps),
  }),
);

export const procedureDraftExecutionStepsRelations = relations(
  procedureDraftExecutionSteps,
  ({ one }) => ({
    execution: one(procedureDraftExecutions, {
      fields: [procedureDraftExecutionSteps.executionId],
      references: [procedureDraftExecutions.id],
    }),
  }),
);

export type ProcedureDraftRun = typeof procedureDraftRuns.$inferSelect;
export type NewProcedureDraftRun = typeof procedureDraftRuns.$inferInsert;
export type ProcedureDraftProposal = typeof procedureDraftProposals.$inferSelect;
export type NewProcedureDraftProposal = typeof procedureDraftProposals.$inferInsert;
export type ProcedureDraftExecution = typeof procedureDraftExecutions.$inferSelect;
export type NewProcedureDraftExecution = typeof procedureDraftExecutions.$inferInsert;
export type ProcedureDraftExecutionStep = typeof procedureDraftExecutionSteps.$inferSelect;
export type NewProcedureDraftExecutionStep = typeof procedureDraftExecutionSteps.$inferInsert;
