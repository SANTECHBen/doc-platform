import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  customType,
  index,
} from 'drizzle-orm/pg-core';
import { contentPackVersions, documents } from './content';
import { organizations } from './organizations';

// pgvector column type. Dimension matches the embedding model (voyage-3 = 1024).
// Change here AND run a re-embed if the model changes.
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

// Chunks are the retrieval unit for RAG. One Document yields many Chunks.
// Chunks are pinned to a ContentPackVersion — retrieval for a conversation pulls
// only chunks belonging to the pinned version (plus any layered overlay versions).
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    contentPackVersionId: uuid('content_pack_version_id')
      .notNull()
      .references(() => contentPackVersions.id, { onDelete: 'cascade' }),
    // Denormalized owner org for defense-in-depth tenant scoping. The chat
    // retriever WHEREs on both contentPackVersionId AND ownerOrganizationId
    // so a bug in the version-id calculation can't leak chunks across
    // tenants. Mirrors the same column on search_index_items. Backfilled
    // by migration 0043.
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Sequence within the document (for reconstructing context windows).
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    // Character offsets inside the source document, for citation provenance.
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    // Page number for PDF source documents.
    page: integer('page'),
    // Embedding dimension must match EMBEDDING_MODEL (voyage-3 = 1024).
    embedding: vector('embedding', 1024),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packVersionIdx: index('document_chunks_pack_version_idx').on(t.contentPackVersionId),
    documentIdx: index('document_chunks_document_idx').on(t.documentId),
    ownerOrgIdx: index('document_chunks_owner_org_idx').on(t.ownerOrganizationId),
  }),
);

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;
