import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { assetModels } from './assets';
import { contentPackStatusEnum, contentLayerTypeEnum, documentKindEnum } from './enums';

// ContentPack = named bundle of docs + training + parts authored against an AssetModel.
// Layer type determines how it composes with others at render time:
//   base            — authored by the AssetModel's owner OEM.
//   dealer_overlay  — authored by a dealer/integrator; layers on top of a base pack.
//   site_overlay    — authored by the end-customer for site-specific additions.
//
// A ContentPack is a logical identity; the actual content lives in ContentPackVersion,
// which is immutable once published. Safety-critical compliance requires that we can
// prove which version a user saw on a given date.
export const contentPacks = pgTable(
  'content_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetModelId: uuid('asset_model_id')
      .notNull()
      .references(() => assetModels.id, { onDelete: 'restrict' }),
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    layerType: contentLayerTypeEnum('layer_type').notNull(),
    // For overlays: which base pack do we layer onto.
    basePackId: uuid('base_pack_id').references((): any => contentPacks.id, {
      onDelete: 'restrict',
    }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOwnerSlug: unique().on(t.ownerOrganizationId, t.slug),
    assetModelIdx: index('content_packs_asset_model_idx').on(t.assetModelId),
  }),
);

// Immutable snapshot. Once status transitions to 'published', rows referencing this
// version (documents, training modules, etc.) are frozen.
export const contentPackVersions = pgTable(
  'content_pack_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentPackId: uuid('content_pack_id')
      .notNull()
      .references(() => contentPacks.id, { onDelete: 'cascade' }),
    // Monotonic per contentPackId. Computed server-side at publish.
    versionNumber: integer('version_number').notNull(),
    // Human-readable semver-ish tag (e.g., "2.3.1"). Optional.
    versionLabel: text('version_label'),
    status: contentPackStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by'),
    changelog: text('changelog'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPackVersion: unique().on(t.contentPackId, t.versionNumber),
  }),
);

// A Document is a single authored artifact within a ContentPackVersion.
// safetyCritical = true blocks AI from paraphrasing; it MUST quote verbatim and link.
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentPackVersionId: uuid('content_pack_version_id')
      .notNull()
      .references(() => contentPackVersions.id, { onDelete: 'cascade' }),
    kind: documentKindEnum('kind').notNull(),
    title: text('title').notNull(),
    // For markdown/structured_procedure: the authored body.
    bodyMarkdown: text('body_markdown'),
    // For pdf/video/schematic: a storage pointer.
    storageKey: text('storage_key'),
    storageBucket: text('storage_bucket'),
    // For video: a Mux/Cloudflare Stream playback identifier.
    streamPlaybackId: text('stream_playback_id'),
    // For external_video: YouTube/Vimeo/OEM-hosted URL. Rendered as iframe.
    externalUrl: text('external_url'),
    // Preview image for doc cards — pdf page 1, video still, or manual upload.
    // Makes list scanning 10x faster than icon + title alone.
    thumbnailStorageKey: text('thumbnail_storage_key'),
    // Original filename at upload time (shown in UI, used for download).
    originalFilename: text('original_filename'),
    // MIME content type of uploaded artifact.
    contentType: text('content_type'),
    // Size in bytes.
    sizeBytes: integer('size_bytes'),
    language: text('language').notNull().default('en'),
    // Localizations: sibling rows with the same groupId in different languages.
    localizationGroupId: uuid('localization_group_id').notNull().defaultRandom(),
    safetyCritical: boolean('safety_critical').notNull().default(false),
    orderingHint: integer('ordering_hint').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packIdx: index('documents_pack_version_idx').on(t.contentPackVersionId),
    locGroupIdx: index('documents_localization_group_idx').on(t.localizationGroupId),
  }),
);

export const contentPacksRelations = relations(contentPacks, ({ one, many }) => ({
  assetModel: one(assetModels, {
    fields: [contentPacks.assetModelId],
    references: [assetModels.id],
  }),
  owner: one(organizations, {
    fields: [contentPacks.ownerOrganizationId],
    references: [organizations.id],
  }),
  basePack: one(contentPacks, {
    fields: [contentPacks.basePackId],
    references: [contentPacks.id],
    relationName: 'pack_base',
  }),
  overlays: many(contentPacks, { relationName: 'pack_base' }),
  versions: many(contentPackVersions),
}));

export const contentPackVersionsRelations = relations(contentPackVersions, ({ one, many }) => ({
  pack: one(contentPacks, {
    fields: [contentPackVersions.contentPackId],
    references: [contentPacks.id],
  }),
  documents: many(documents),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  packVersion: one(contentPackVersions, {
    fields: [documents.contentPackVersionId],
    references: [contentPackVersions.id],
  }),
}));

export type ContentPack = typeof contentPacks.$inferSelect;
export type NewContentPack = typeof contentPacks.$inferInsert;
export type ContentPackVersion = typeof contentPackVersions.$inferSelect;
export type NewContentPackVersion = typeof contentPackVersions.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
