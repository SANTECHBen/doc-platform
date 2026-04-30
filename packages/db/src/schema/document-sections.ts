import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { documents } from './content';
import { parts } from './parts';
import { users } from './users';
import { agentRuns } from './agent';

// Document Sections — admin-authored annotations on a single uploaded
// document that point at page ranges, text excerpts, or video time ranges,
// each linkable to one or more parts.
//
// When a tech scans a part QR on the PWA, they see ONLY linked sections
// (strict fallback). The full document is hidden if it has any sections
// that don't apply to this part. Re-uploads soft-flag drifted sections for
// admin re-validation rather than silently corrupting anchors.
//
// Three anchor kinds, discriminated by `kind`. A single CHECK constraint
// (in the migration, not modeled here) enforces that the right column set
// is populated per kind:
//   - page_range: page_start, page_end (1-indexed, inclusive)
//   - text_range: anchor_excerpt + optional context windows + optional
//     text_page_hint (PDF only). Excerpt is the durable anchor; chunk IDs
//     would orphan on re-extraction so we don't store them.
//   - time_range: time_start_seconds, time_end_seconds (real, video duration)

export const documentSectionKindEnum = pgEnum('document_section_kind', [
  'page_range',
  'text_range',
  'time_range',
]);

export const documentSections = pgTable(
  'document_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    kind: documentSectionKindEnum('kind').notNull(),

    // Display
    title: text('title').notNull(),
    description: text('description'),

    // page_range (PDF / DOCX / PPTX / schematic)
    pageStart: integer('page_start'),
    pageEnd: integer('page_end'),

    // text_range (markdown / structured_procedure / PDF text-layer refinement)
    // Anchor strategy: store the verbatim excerpt + ~200 chars of surrounding
    // context. On re-extraction, we re-locate by exact match → windowed
    // normalized match → embedding fallback (see packages/ai/src/sections).
    // text_page_hint is set when the selection came from a PDF text layer,
    // pointing at the original page for disambiguation.
    textPageHint: integer('text_page_hint'),
    anchorExcerpt: text('anchor_excerpt'),
    anchorContextBefore: text('anchor_context_before'),
    anchorContextAfter: text('anchor_context_after'),

    // time_range (video / external_video)
    timeStartSeconds: doublePrecision('time_start_seconds'),
    timeEndSeconds: doublePrecision('time_end_seconds'),

    // Common
    orderingHint: integer('ordering_hint').notNull().default(0),
    safetyCritical: boolean('safety_critical').notNull().default(false),

    // Re-validation soft flag — set true when the parent document's
    // extracted text changes and our anchors might be stale. PWA omits
    // flagged sections; admin sees them with a banner + "review" action.
    needsRevalidation: boolean('needs_revalidation').notNull().default(false),
    revalidationReason: text('revalidation_reason'),
    // Snapshot of documents.extractedAt at section author-time / last
    // successful validation. The revalidator skips sections whose
    // sourceExtractionAt is already >= the document's current extractedAt.
    sourceExtractionAt: timestamp('source_extraction_at', { withTimezone: true }),

    // Forward-compat for the onboarding agent emitting section proposals
    // (v2 feature). Null today; populated when the agent's executor
    // accepts a proposal as a section.
    proposedByAgentRunId: uuid('proposed_by_agent_run_id').references(
      () => agentRuns.id,
      { onDelete: 'set null' },
    ),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index('document_sections_document_idx').on(t.documentId),
    flagIdx: index('document_sections_flag_idx').on(t.documentId, t.needsRevalidation),
  }),
);

// Many-to-many: a section can apply to many parts; a part can reference
// many sections (across many documents).
export const partDocumentSections = pgTable(
  'part_document_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    documentSectionId: uuid('document_section_id')
      .notNull()
      .references(() => documentSections.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPartSection: unique('part_document_sections_part_section_uniq').on(
      t.partId,
      t.documentSectionId,
    ),
    partIdx: index('part_document_sections_part_idx').on(t.partId),
    sectionIdx: index('part_document_sections_section_idx').on(t.documentSectionId),
  }),
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const documentSectionsRelations = relations(documentSections, ({ one, many }) => ({
  document: one(documents, {
    fields: [documentSections.documentId],
    references: [documents.id],
  }),
  createdBy: one(users, {
    fields: [documentSections.createdByUserId],
    references: [users.id],
  }),
  proposedByAgentRun: one(agentRuns, {
    fields: [documentSections.proposedByAgentRunId],
    references: [agentRuns.id],
  }),
  partLinks: many(partDocumentSections),
}));

export const partDocumentSectionsRelations = relations(
  partDocumentSections,
  ({ one }) => ({
    part: one(parts, {
      fields: [partDocumentSections.partId],
      references: [parts.id],
    }),
    section: one(documentSections, {
      fields: [partDocumentSections.documentSectionId],
      references: [documentSections.id],
    }),
    createdBy: one(users, {
      fields: [partDocumentSections.createdByUserId],
      references: [users.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocumentSectionKind = (typeof documentSectionKindEnum.enumValues)[number];
export type DocumentSection = typeof documentSections.$inferSelect;
export type NewDocumentSection = typeof documentSections.$inferInsert;
export type PartDocumentSection = typeof partDocumentSections.$inferSelect;
export type NewPartDocumentSection = typeof partDocumentSections.$inferInsert;
