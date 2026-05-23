import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';
import { procedureStepKindEnum } from './enums';
import type { StepBlock } from './procedures';

// Reusable step snippets — authors define standard content once
// ("Lockout-Tagout", "Safety Briefing") and reference it from any procedure
// step. References resolve at read time (always-latest semantics): editing a
// snippet propagates instantly to every non-detached referring step.
//
// Ownership:
//   is_platform = true  →  global (SANTECH-published). owner_organization_id
//                          is NULL. Visible to every org; writable only by
//                          platform admins.
//   is_platform = false →  org-scoped. owner_organization_id required.
//
// A CHECK constraint enforces the (is_platform, owner_organization_id)
// pairing — written in the migration, not modeled here.
//
// Detach semantics live on procedure_steps (snippet_detached). On first inline
// edit, the step copies the snippet's current content into its own columns and
// sets snippet_detached=true. The step then drifts independently; the snippet
// id and badge remain as informational provenance.
export const procedureSnippets = pgTable(
  'procedure_snippets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerOrganizationId: uuid('owner_organization_id').references(
      () => organizations.id,
      { onDelete: 'cascade' },
    ),
    isPlatform: boolean('is_platform').notNull().default(false),
    title: text('title').notNull(),
    kind: procedureStepKindEnum('kind').notNull().default('instruction'),
    // Block content — same discriminated union as procedure_steps.blocks.
    // Snippets carry block content only; evidence requirements
    // (requiresPhoto, measurementSpec, safetyCritical) live on the step row.
    blocks: jsonb('blocks').$type<StepBlock[]>().notNull().default([]),
    // Free-form tags for picker filtering.
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Case-insensitive title uniqueness per scope. Platform snippets use the
    // sentinel 'PLATFORM' to share a namespace separate from any org's.
    orgTitleUniq: unique('procedure_snippets_org_title_uniq').on(
      t.ownerOrganizationId,
      t.title,
    ),
    ownerIdx: index('procedure_snippets_owner_idx').on(t.ownerOrganizationId),
    platformIdx: index('procedure_snippets_platform_idx')
      .on(t.isPlatform)
      .where(sql`is_platform = true`),
  }),
);

// Append-only revision log. Snapshots full title + blocks on every PATCH.
// The read path does not consult this table — it exists solely for audit
// and history-tab rendering.
export const procedureSnippetRevisions = pgTable(
  'procedure_snippet_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snippetId: uuid('snippet_id')
      .notNull()
      .references(() => procedureSnippets.id, { onDelete: 'cascade' }),
    revisionNumber: integer('revision_number').notNull(),
    title: text('title').notNull(),
    blocks: jsonb('blocks').$type<StepBlock[]>().notNull().default([]),
    changeNote: text('change_note'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    snippetRevUniq: unique('procedure_snippet_revisions_snippet_rev_uniq').on(
      t.snippetId,
      t.revisionNumber,
    ),
    snippetIdx: index('procedure_snippet_revisions_snippet_idx').on(t.snippetId),
  }),
);

export const procedureSnippetsRelations = relations(procedureSnippets, ({ one, many }) => ({
  owner: one(organizations, {
    fields: [procedureSnippets.ownerOrganizationId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [procedureSnippets.createdByUserId],
    references: [users.id],
  }),
  revisions: many(procedureSnippetRevisions),
}));

export const procedureSnippetRevisionsRelations = relations(
  procedureSnippetRevisions,
  ({ one }) => ({
    snippet: one(procedureSnippets, {
      fields: [procedureSnippetRevisions.snippetId],
      references: [procedureSnippets.id],
    }),
    createdBy: one(users, {
      fields: [procedureSnippetRevisions.createdByUserId],
      references: [users.id],
    }),
  }),
);

export type ProcedureSnippet = typeof procedureSnippets.$inferSelect;
export type NewProcedureSnippet = typeof procedureSnippets.$inferInsert;
export type ProcedureSnippetRevision = typeof procedureSnippetRevisions.$inferSelect;
export type NewProcedureSnippetRevision = typeof procedureSnippetRevisions.$inferInsert;
