import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { documents } from './content';
import { parts } from './parts';
import { users } from './users';
import { assetInstances } from './assets';
import { agentRuns } from './agent';
import { workOrders } from './workorders';
import { procedureSnippets } from './snippets';
import { procedureStepKindEnum, procedureRunStatusEnum } from './enums';

// Procedure mode — turns kind=structured_procedure documents into
// interactive checklists.
//
// Model split:
//   procedure_steps             — author-time content. One row per
//                                 step on a document.
//   procedure_runs              — runtime instance. One row per
//                                 (tech, doc, asset) attempt.
//   procedure_step_completions  — runtime evidence. One row per
//                                 (run, step), upserted on re-completion.
//   part_procedure_steps        — many-to-many linking steps to parts,
//                                 mirrors part_document_sections so the
//                                 AI / part-scoped retrieval can surface
//                                 steps as first-class units.
//
// CHECK constraints (enforced in the migration, not modeled here):
//   procedure_steps:
//     (kind = 'measurement_required') = (measurement_spec IS NOT NULL)
//     (kind = 'photo_required') -> (requires_photo AND min_photo_count >= 1)
//   procedure_step_completions:
//     outcome IN ('completed', 'skipped')
//     (outcome = 'skipped') = (skip_reason IS NOT NULL)

// Per-step media — author-attached photos and videos that render as
// part of the procedure's content (vs procedure_step_completions.photos
// which are evidence captured during a run). Stored as jsonb so an
// individual step can carry an arbitrary number of media items in
// authored order.
export type ProcedureStepMedia = {
  /** 'image' for jpeg/png/webp; 'video' for any video/* mime. */
  kind: 'image' | 'video';
  storageKey: string;
  mime: string;
  /** Optional author caption rendered below the media. */
  caption?: string;
};

// Typed content blocks on a step. Replaces the freeform `bodyMarkdown`
// field with a discriminated union that the template renders. Authors
// pick block kinds from a slash menu; they never type formatting
// syntax. The template owns all visual style — every callout looks the
// same, every key-value table looks the same — so the cognitive cost
// to a tech reading mid-procedure is constant across the library.
//
// Storage: jsonb array on procedure_steps.blocks (default: empty array).
// Render order = array order. The legacy `bodyMarkdown` field stays as
// a fallback for unmigrated rows; new authoring writes only blocks.
export type StepBlock =
  | {
      kind: 'paragraph';
      /** Plain text. Inline links are auto-detected at render time;
       *  authors cannot apply bold/italic/etc. — that's the template's job. */
      text: string;
    }
  | {
      kind: 'callout';
      /** Visual treatment selected by the author; styled by the template. */
      tone: 'safety' | 'warning' | 'tip' | 'note';
      title?: string;
      text: string;
    }
  | {
      kind: 'bullet_list';
      items: string[];
    }
  | {
      kind: 'numbered_list';
      items: string[];
    }
  | {
      kind: 'key_value';
      /** Heading row labels — exactly two columns for v1. */
      columns: [string, string];
      rows: Array<[string, string]>;
    }
  | {
      kind: 'photo_inline';
      /** References an item already in step.media[] by storageKey. */
      storageKey: string;
      caption?: string;
    };

// Discriminated union for measurement specs. Numeric covers torque/spec
// values; pass_fail covers visual inspections; free_text covers things
// like "record the serial number on the replacement part."
export type MeasurementSpec =
  | {
      kind: 'numeric';
      label: string;
      unit: string;
      min?: number | null;
      max?: number | null;
      expected?: number | null;
      tolerancePct?: number | null;
    }
  | {
      kind: 'pass_fail';
      label: string;
      passLabel?: string;
      failLabel?: string;
    }
  | {
      kind: 'free_text';
      label: string;
      placeholder?: string;
      maxLen?: number;
    };

// Procedure sections — optional grouping above procedure_steps. A single
// document can split into named phases (Removal, Replacement, Verification)
// with step numbering restarting per section. Existing pre-migration steps
// land in a default "Steps" section via the 0021 backfill so nothing changes
// visually for unmigrated procedures.
//
// onDelete: cascade on document — deleting the doc takes its sections with it.
// onDelete: set null on procedure_steps.section_id — deleting a section
// orphans (doesn't delete) its steps; the UI renders orphans above the first
// explicit section.
export const procedureSections = pgTable(
  'procedure_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    orderingHint: integer('ordering_hint').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Search-index dirty-bit. Same lazy re-embed pattern as
    // procedure_steps.searchIndexStaleAt.
    searchIndexStaleAt: timestamp('search_index_stale_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index('procedure_sections_document_idx').on(t.documentId),
    docOrderIdx: index('procedure_sections_document_order_idx').on(
      t.documentId,
      t.orderingHint,
    ),
  }),
);

export const procedureSteps = pgTable(
  'procedure_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Nullable: pre-section steps live "above" sections. The 0021 backfill
    // puts every existing step in a default "Steps" section, but new orphans
    // are still allowed (e.g., admin deletes a section — its steps survive
    // with section_id = null and render at the top).
    sectionId: uuid('section_id').references((): any => procedureSections.id, {
      onDelete: 'set null',
    }),

    // Optional sub-procedure link. When set, the PWA Job Aid renders a
    // "Run sub-procedure: <title>" button below this step's content. Tapping
    // it pushes the linked procedure as a nested Job Aid (stacked with a
    // breadcrumb) and returns here on completion or close. Useful for
    // "if necessary" branches — e.g., an inspection step that conditionally
    // launches the Belt Replacement procedure when the belt is out of spec.
    // onDelete: set null so deleting the linked doc just clears the link
    // rather than nuking the parent step. API validates the target is
    // structured_procedure in the same content pack version.
    linkedProcedureDocId: uuid('linked_procedure_doc_id').references(
      () => documents.id,
      { onDelete: 'set null' },
    ),
    // Optional step subset for the linked sub-procedure. Empty (default)
    // means "play the whole linked procedure"; non-empty filters the
    // linked doc's steps to just these IDs at render time, preserving
    // the linked doc's natural ordering. Useful when the parent step
    // only needs a few steps from a longer procedure ("see steps 3-5 of
    // Belt Replacement" rather than the full 12-step procedure).
    linkedProcedureStepIds: jsonb('linked_procedure_step_ids')
      .$type<string[]>()
      .notNull()
      .default([]),

    kind: procedureStepKindEnum('kind').notNull().default('instruction'),

    // Display + per-step body. bodyMarkdown lets authors embed images,
    // lists, links to specs in a step. Doc-level bodyMarkdown stays
    // available read-only as a side panel during authoring (helps split
    // existing single-blob procedures into steps).
    title: text('title').notNull(),
    bodyMarkdown: text('body_markdown'),
    safetyCritical: boolean('safety_critical').notNull().default(false),

    // Sequencing. Drag-reorder rewrites these spaced by 100 so a single
    // move doesn't rewrite every row.
    orderingHint: integer('ordering_hint').notNull().default(0),

    // Evidence requirements. requiresPhoto + minPhotoCount work together;
    // measurementSpec is null unless kind = 'measurement_required'.
    requiresPhoto: boolean('requires_photo').notNull().default(false),
    minPhotoCount: integer('min_photo_count').notNull().default(0),
    measurementSpec: jsonb('measurement_spec').$type<MeasurementSpec | null>(),

    // Authored media — photos and (optional) video the author attaches
    // to this step as content (rendered in the doc viewer). Distinct
    // from procedure_step_completions.photos, which is evidence per-run.
    media: jsonb('media')
      .$type<ProcedureStepMedia[]>()
      .notNull()
      .default([]),

    // Typed structured content blocks. New authoring writes here; legacy
    // procedures still carry their content in `bodyMarkdown` until
    // migrated. The template renders the array in order — see StepBlock
    // for the discriminated union.
    blocks: jsonb('blocks')
      .$type<StepBlock[]>()
      .notNull()
      .default([]),

    // ---------- Authored voiceover ----------
    // Optional pre-recorded narration attached to this step. When set, the
    // PWA's VirtualJobAid plays this file instead of synthesizing TTS at
    // run time — better fidelity (custom emphasis, your senior tech's
    // voice, mid-sentence pauses), zero per-play cost. Generated by either
    // a) admin file upload, b) admin in-browser recording, or c) one-shot
    // OpenAI TTS-1-HD synthesis pinned to S3. All three converge to a
    // storage_key the runner fetches via storage.publicUrl().
    audioStorageKey: text('audio_storage_key'),
    audioContentType: text('audio_content_type'),
    audioSizeBytes: integer('audio_size_bytes'),
    // Duration in milliseconds. Lets the admin UI show length without
    // probing the file, and the runner schedule auto-advance reliably.
    audioDurationMs: integer('audio_duration_ms'),
    // 'uploaded' = admin file pick or browser recording.
    // 'generated' = synthesized via OpenAI TTS (cheap to regenerate after
    // text edits; admin sees a "Re-generate" button when the source text
    // diverges).
    audioSource: text('audio_source'),

    // Forward-compat: agent-proposed steps land here when the executor
    // accepts an agent run's step proposal. Null today.
    proposedByAgentRunId: uuid('proposed_by_agent_run_id').references(
      () => agentRuns.id,
      { onDelete: 'set null' },
    ),

    // Reusable-snippet link. When set and `snippetDetached=false`, the read
    // path expands this step's blocks/title from procedure_snippets at
    // render time (always-latest semantics — edits to the snippet propagate
    // instantly to every referring step). First inline edit on the step
    // sets `snippetDetached=true` and copies the snippet's current content
    // into the step's own columns; subsequent edits drift independently.
    // onDelete: set null so deleting a snippet does not nuke referring
    // steps (the badge becomes orphaned but the step content survives via
    // detach-on-edit; routes refuse to delete a snippet with attached
    // non-detached references).
    snippetId: uuid('snippet_id').references(() => procedureSnippets.id, {
      onDelete: 'set null',
    }),
    snippetDetached: boolean('snippet_detached').notNull().default(false),

    // Search-index dirty-bit. Set to now() on every write that affects
    // searchable text (title, blocks, kind). The 60-second sweeper picks
    // up rows whose stale_at > embedded_at and re-embeds them. Indexing
    // never blocks the PATCH response — Voyage's retry backoff would
    // tank step-save latency.
    searchIndexStaleAt: timestamp('search_index_stale_at', {
      withTimezone: true,
    }),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index('procedure_steps_document_idx').on(t.documentId),
    docOrderIdx: index('procedure_steps_document_order_idx').on(
      t.documentId,
      t.orderingHint,
    ),
    sectionOrderIdx: index('procedure_steps_section_order_idx').on(
      t.sectionId,
      t.orderingHint,
    ),
    // Partial index for snippet reverse-lookup ("which steps use snippet X?").
    snippetIdx: index('procedure_steps_snippet_idx')
      .on(t.snippetId)
      .where(sql`snippet_id IS NOT NULL`),
  }),
);

// Substeps — author-defined nested steps within a procedure step. Used
// when a step expands into a few smaller actions ("Loosen fasteners
// → 1) front bolt 2) rear bolt 3) cover plate"). Substeps render in
// the viewer but are not separately tracked in run-with-evidence mode
// (the parent step's completion captures evidence for the whole group).
export const procedureSubsteps = pgTable(
  'procedure_substeps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    procedureStepId: uuid('procedure_step_id')
      .notNull()
      .references(() => procedureSteps.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    bodyMarkdown: text('body_markdown'),
    orderingHint: integer('ordering_hint').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stepIdx: index('procedure_substeps_step_idx').on(t.procedureStepId),
    stepOrderIdx: index('procedure_substeps_step_order_idx').on(
      t.procedureStepId,
      t.orderingHint,
    ),
  }),
);

// Many-to-many between parts and procedure steps. Mirror of
// part_document_sections — an instructed step about replacing the inner
// race of a bearing assembly should be addressable both from the bearing
// part page and from the assembly part page.
export const partProcedureSteps = pgTable(
  'part_procedure_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    procedureStepId: uuid('procedure_step_id')
      .notNull()
      .references(() => procedureSteps.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: unique('part_procedure_steps_uniq').on(t.partId, t.procedureStepId),
    partIdx: index('part_procedure_steps_part_idx').on(t.partId),
    stepIdx: index('part_procedure_steps_step_idx').on(t.procedureStepId),
  }),
);

// Runtime: one row created when a tech taps Start. Rows are workspaces,
// not registrations — we never create empty rows the way enrollments do.
//
// userId is NOT NULL: every run has an attributable tech. Reading docs
// stays scan-only; starting a run requires auth (OIDC). See plan for
// rationale (competency tracking depends on it).
//
// onDelete patterns: documentId set null (run is historical evidence,
// outliving the doc); userId cascade (removing a user purges their run
// history); assetInstanceId / workOrderId set null (run survives the
// associations).
export const procedureRuns = pgTable(
  'procedure_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetInstanceId: uuid('asset_instance_id').references(() => assetInstances.id, {
      onDelete: 'set null',
    }),
    workOrderId: uuid('work_order_id').references(() => workOrders.id, {
      onDelete: 'set null',
    }),

    status: procedureRunStatusEnum('status').notNull().default('in_progress'),
    abandonedReason: text('abandoned_reason'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Last user-driven activity. Powers a v2 idle-run sweeper.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Active wall-time excluding paused intervals. Recomputed on
    // pause/resume; final value frozen on completed/abandoned.
    totalActiveMs: integer('total_active_ms').notNull().default(0),
    // Set when status = 'paused', cleared on resume. Lets us account
    // for active time even if the server restarts mid-pause.
    pausedAt: timestamp('paused_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('procedure_runs_user_idx').on(t.userId),
    docIdx: index('procedure_runs_document_idx').on(t.documentId),
    assetIdx: index('procedure_runs_asset_idx').on(t.assetInstanceId),
    // Prevent a tech from accidentally double-starting the same procedure
    // in two tabs. Partial — completed/abandoned rows don't block re-runs.
    activeUniq: uniqueIndex('procedure_runs_active_uniq')
      .on(t.userId, t.documentId, t.assetInstanceId)
      .where(sql`status IN ('in_progress', 'paused')`),
  }),
);

// Per-step evidence within a run. Upsert on (runId, stepId) — re-completion
// overwrites prior evidence (with audit trail in the audit log).
//
// stepId uses onDelete: 'restrict' so an admin can't silently delete a
// step that has historical run evidence; the admin route returns 409.
export const procedureStepCompletions = pgTable(
  'procedure_step_completions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => procedureRuns.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id')
      .notNull()
      .references(() => procedureSteps.id, { onDelete: 'restrict' }),

    // 'completed' | 'skipped'. Free text rather than an enum because the
    // value space is fully covered by the CHECK constraint and stays
    // small; matching the workOrders.attachments-as-jsonb precedent of
    // accepting a small text discriminator without ceremony.
    outcome: text('outcome').notNull(),
    skipReason: text('skip_reason'),

    // Mirrors the work_orders.attachments shape exactly so the same
    // upload helpers fan out cleanly.
    photos: jsonb('photos')
      .$type<Array<{ key: string; mime: string; caption?: string }>>()
      .notNull()
      .default([]),

    // Typed columns per measurement kind — exactly one populated based
    // on step.measurementSpec.kind. Typed > jsonb here because BI/audit
    // queries ("torque values out of spec last quarter") become trivial.
    numericValue: doublePrecision('numeric_value'),
    passFailValue: text('pass_fail_value'),
    textValue: text('text_value'),
    // Set true when a numeric value violates min/max but the tech
    // explicitly confirmed the override. Server records the violation
    // alongside the override reason rather than rejecting outright.
    measurementOutOfSpec: boolean('measurement_out_of_spec').notNull().default(false),
    measurementOverrideReason: text('measurement_override_reason'),

    notes: text('notes'),

    // Time accounting. enteredAt is supplied by the client (when the tech
    // first navigated to the step card); completedAt is server-set on
    // tap. timeMs is the elapsed delta minus any pause windows that
    // landed inside it (computed in the route handler).
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    timeMs: integer('time_ms').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runStepUniq: unique('procedure_step_completions_run_step_uniq').on(
      t.runId,
      t.stepId,
    ),
    runIdx: index('procedure_step_completions_run_idx').on(t.runId),
  }),
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const procedureSectionsRelations = relations(procedureSections, ({ one, many }) => ({
  document: one(documents, {
    fields: [procedureSections.documentId],
    references: [documents.id],
  }),
  createdBy: one(users, {
    fields: [procedureSections.createdByUserId],
    references: [users.id],
  }),
  steps: many(procedureSteps),
}));

export const procedureStepsRelations = relations(procedureSteps, ({ one, many }) => ({
  document: one(documents, {
    fields: [procedureSteps.documentId],
    references: [documents.id],
  }),
  section: one(procedureSections, {
    fields: [procedureSteps.sectionId],
    references: [procedureSections.id],
  }),
  createdBy: one(users, {
    fields: [procedureSteps.createdByUserId],
    references: [users.id],
  }),
  proposedByAgentRun: one(agentRuns, {
    fields: [procedureSteps.proposedByAgentRunId],
    references: [agentRuns.id],
  }),
  snippet: one(procedureSnippets, {
    fields: [procedureSteps.snippetId],
    references: [procedureSnippets.id],
  }),
  partLinks: many(partProcedureSteps),
  substeps: many(procedureSubsteps),
}));

export const procedureSubstepsRelations = relations(procedureSubsteps, ({ one }) => ({
  step: one(procedureSteps, {
    fields: [procedureSubsteps.procedureStepId],
    references: [procedureSteps.id],
  }),
  createdBy: one(users, {
    fields: [procedureSubsteps.createdByUserId],
    references: [users.id],
  }),
}));

export const partProcedureStepsRelations = relations(partProcedureSteps, ({ one }) => ({
  part: one(parts, {
    fields: [partProcedureSteps.partId],
    references: [parts.id],
  }),
  step: one(procedureSteps, {
    fields: [partProcedureSteps.procedureStepId],
    references: [procedureSteps.id],
  }),
  createdBy: one(users, {
    fields: [partProcedureSteps.createdByUserId],
    references: [users.id],
  }),
}));

export const procedureRunsRelations = relations(procedureRuns, ({ one, many }) => ({
  document: one(documents, {
    fields: [procedureRuns.documentId],
    references: [documents.id],
  }),
  user: one(users, {
    fields: [procedureRuns.userId],
    references: [users.id],
  }),
  assetInstance: one(assetInstances, {
    fields: [procedureRuns.assetInstanceId],
    references: [assetInstances.id],
  }),
  workOrder: one(workOrders, {
    fields: [procedureRuns.workOrderId],
    references: [workOrders.id],
  }),
  completions: many(procedureStepCompletions),
}));

export const procedureStepCompletionsRelations = relations(
  procedureStepCompletions,
  ({ one }) => ({
    run: one(procedureRuns, {
      fields: [procedureStepCompletions.runId],
      references: [procedureRuns.id],
    }),
    step: one(procedureSteps, {
      fields: [procedureStepCompletions.stepId],
      references: [procedureSteps.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcedureStepKind = (typeof procedureStepKindEnum.enumValues)[number];
export type ProcedureRunStatus = (typeof procedureRunStatusEnum.enumValues)[number];

export type ProcedureSection = typeof procedureSections.$inferSelect;
export type NewProcedureSection = typeof procedureSections.$inferInsert;
export type ProcedureStep = typeof procedureSteps.$inferSelect;
export type NewProcedureStep = typeof procedureSteps.$inferInsert;
export type ProcedureSubstep = typeof procedureSubsteps.$inferSelect;
export type NewProcedureSubstep = typeof procedureSubsteps.$inferInsert;
export type PartProcedureStep = typeof partProcedureSteps.$inferSelect;
export type NewPartProcedureStep = typeof partProcedureSteps.$inferInsert;
export type ProcedureRun = typeof procedureRuns.$inferSelect;
export type NewProcedureRun = typeof procedureRuns.$inferInsert;
export type ProcedureStepCompletion = typeof procedureStepCompletions.$inferSelect;
export type NewProcedureStepCompletion = typeof procedureStepCompletions.$inferInsert;
