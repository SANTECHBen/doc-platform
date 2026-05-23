import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  customType,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { contentPackVersions, documents } from './content';

// pgvector column type — matches document_chunks' embedding shape. Voyage
// voyage-3-large = 1024 dims. Change here AND run a re-embed if the model
// ever changes.
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      return value.slice(1, -1).split(',').map(Number);
    },
  })(name);

// Unified search index for the voice-search and admin global-search
// features. Parallel to document_chunks but with a different lifecycle:
//   - document_chunks is version-bound and wiped on republish (whole-doc
//     re-extract).
//   - search_index_items contains rows per-step / per-section / per-chunk
//     so a step edit only invalidates its own row (lazy re-embed via
//     search_index_stale_at on the source table).
//
// The downside of unifying step/section/chunk into one table is that the
// retriever has to know how to materialize "jump URLs" per source_type.
// We accept that trade — keeping one IVFFlat index hot across all three
// surfaces is worth the type-dispatch cost in the retriever.
export const searchSourceTypeEnum = pgEnum('search_source_type', [
  'doc_chunk',
  'procedure_step',
  'document_section',
]);

export const searchIndexItems = pgTable(
  'search_index_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentPackVersionId: uuid('content_pack_version_id')
      .notNull()
      .references(() => contentPackVersions.id, { onDelete: 'cascade' }),
    // Nullable because doc_sections / doc_chunks have a documentId but a
    // procedure_step's document_id is also useful for jump-url assembly.
    // Kept on every row that has one so the retriever can produce a deep
    // link without a second query.
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'cascade',
    }),
    // Denormalized owner-org for fast scope filtering. Cheaper than
    // joining content_packs on every query. Always non-null at insert
    // time; the indexer resolves it from the doc's pack on the way in.
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sourceType: searchSourceTypeEnum('source_type').notNull(),
    // The id of the source row (chunk / step / section). Combined with
    // (content_pack_version_id, source_type) for uniqueness.
    sourceId: uuid('source_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    // SHA-256 of the embedded text. Lets the reindex sweeper skip the
    // Voyage call when content is unchanged (e.g., when the source row's
    // updated_at bumps for an irrelevant field).
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', 1024),
    // Free-form per-source metadata used to build the jump URL — e.g.,
    // { stepIndex, sectionTitle, pageStart, pageEnd }. Validated by the
    // indexer per source_type; the retriever consumes it opaquely.
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packTypeIdx: index('search_index_pack_type_idx').on(
      t.contentPackVersionId,
      t.sourceType,
    ),
    ownerIdx: index('search_index_org_idx').on(t.ownerOrganizationId),
    sourceUniq: unique('search_index_source_uniq').on(
      t.contentPackVersionId,
      t.sourceType,
      t.sourceId,
    ),
    // ivfflat / GIN indexes are declared in the migration SQL — Drizzle's
    // builder doesn't model them.
  }),
);

export const searchIndexItemsRelations = relations(searchIndexItems, ({ one }) => ({
  contentPackVersion: one(contentPackVersions, {
    fields: [searchIndexItems.contentPackVersionId],
    references: [contentPackVersions.id],
  }),
  document: one(documents, {
    fields: [searchIndexItems.documentId],
    references: [documents.id],
  }),
  ownerOrganization: one(organizations, {
    fields: [searchIndexItems.ownerOrganizationId],
    references: [organizations.id],
  }),
}));

export type SearchIndexItem = typeof searchIndexItems.$inferSelect;
export type NewSearchIndexItem = typeof searchIndexItems.$inferInsert;
export type SearchSourceType = (typeof searchSourceTypeEnum.enumValues)[number];
