import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { organizations } from './organizations';
import { assetModels, assetInstances } from './assets';
import { users } from './users';
import {
  contentPackStatusEnum,
  contentPackKindEnum,
  contentLayerTypeEnum,
  documentKindEnum,
  extractionStatusEnum,
} from './enums';

// Procedure-doc template metadata. Stored as typed jsonb on documents.
// Only meaningful when documents.kind = 'structured_procedure'.
//
// Layout: every procedure doc has a fixed section template applied at
// render time. Title + Tools + Steps are always shown. Safety and
// Verification are author-controlled toggles per-doc — when disabled,
// the section is omitted entirely from the rendered template.
/** Structured "Required Tools" — split into three lists so the PWA can
 *  render labeled sub-groups (Common / Special / Consumables) on the
 *  procedure intro screen. Legacy data persisted as a flat `string[]`
 *  is coerced to `{ common: [...], special: [], consumables: [] }` at
 *  read time and normalized by the API zod preprocess. */
export type RequiredTools = {
  common: string[];
  special: string[];
  consumables: string[];
};

/** Coerce a raw jsonb value (or legacy flat array, or undefined) into
 *  the canonical RequiredTools shape. Read paths in admin-sections and
 *  field-procedures use this so clients always see the new shape. */
export function normalizeRequiredTools(raw: unknown): RequiredTools {
  if (Array.isArray(raw)) {
    return {
      common: raw.filter((s): s is string => typeof s === 'string'),
      special: [],
      consumables: [],
    };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Partial<RequiredTools>;
    return {
      common: Array.isArray(o.common) ? o.common : [],
      special: Array.isArray(o.special) ? o.special : [],
      consumables: Array.isArray(o.consumables) ? o.consumables : [],
    };
  }
  return { common: [], special: [], consumables: [] };
}

export type ProcedureDocMetadata = {
  /** Free-text tool buckets. See RequiredTools above for shape +
   *  migration notes. */
  toolsRequired: RequiredTools;
  safety: { enabled: boolean; notes: string | null };
  verification: { enabled: boolean; notes: string | null };
  /** Author-controlled overview fields rendered on the procedure intro
   *  screen (Job Aid "Step 0" panel + scroll-view top). All optional —
   *  legacy procedures without any of these show only the existing
   *  hero/tools/safety summary. */
  summary?: string | null;
  /** Estimated wall-clock time in minutes a tech should budget. */
  estimatedMinutes?: number | null;
  /** Skill-level hint so techs can self-select before starting. */
  skillLevel?: 'basic' | 'intermediate' | 'advanced' | null;
  /** Optional procedure-level intro video — plays on a "Step 0" landing
   *  panel in the PWA's Job Aid view and at the top of the scroll view.
   *  Distinct from per-step videos in `procedure_steps.media`.
   *  Exactly one of `storageKey` (uploaded file) or `sourceUrl` (external
   *  link — YouTube, Vimeo, or a direct mp4/webm URL) must be set. */
  heroVideo?: {
    storageKey?: string;
    sourceUrl?: string;
    mime: string;
    sizeBytes?: number;
    caption?: string | null;
  } | null;
};

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
    // 'authored' = OEM-curated content with the standard draft → published
    // version lifecycle. 'field_captures' = the always-draft pack each
    // asset model gets so techs can author procedures from the PWA on
    // site. Field-captures packs are auto-created on first capture; PWA
    // reads from BOTH kinds and renders an UNVERIFIED chip on field rows
    // until an admin promotes them.
    kind: contentPackKindEnum('kind').notNull().default('authored'),
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
    // At most one field_captures pack per asset model. Partial — leaves
    // room for many authored packs (base, dealer overlays, site overlays).
    fieldCapturesUniq: uniqueIndex('content_packs_field_captures_uniq')
      .on(t.assetModelId)
      .where(sql`kind = 'field_captures'`),
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
    // Per-document switch for the AI chat retriever. When false, the doc's
    // chunks are excluded from chat answers (extraction can still run so
    // the doc is searchable in the admin, but the AI won't quote it). Use
    // to keep unreviewed PDFs out of conversation while leaving them
    // available in the Documents tab. New uploads of pdf / slides /
    // schematic / file / video kinds default false at the API; markdown
    // and structured_procedure default true. Existing rows backfill true
    // so live conversations don't silently lose context.
    aiIndexed: boolean('ai_indexed').notNull().default(true),
    orderingHint: integer('ordering_hint').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    // Lifecycle of the extraction → chunking → embedding pipeline for this doc.
    // markdown/structured_procedure/external_video default to 'not_applicable'.
    // pdf/docx/pptx/slides/schematic start as 'pending' and advance via the pipeline.
    extractionStatus: extractionStatusEnum('extraction_status')
      .notNull()
      .default('not_applicable'),
    // Last error message when extractionStatus = 'failed'. Nullable otherwise.
    extractionError: text('extraction_error'),
    // Cached extracted markdown so we don't re-run the extractor on each re-embed
    // or index rebuild. Populated by the pipeline; treat as opaque text.
    extractedText: text('extracted_text'),
    // When extraction last completed successfully. Also nudged on reprocess.
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    // ---------- Field-authored documents (procedure mode v2) ----------
    // Set when an admin/senior tech reviews a field-captured doc and
    // promotes it. Null on OEM-authored docs (verification is implicit
    // via the publish lifecycle). Together with the parent pack's
    // kind='field_captures', drives the UNVERIFIED chip in the PWA.
    fieldVerifiedAt: timestamp('field_verified_at', { withTimezone: true }),
    fieldVerifiedByUserId: uuid('field_verified_by_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    // When set, the doc is only visible/runnable on this specific asset
    // instance, not the whole asset model. Default null = model-wide.
    // Captured docs default to null (model-wide); the tech can flip
    // "This unit only" at Finish for a serial-specific quirk.
    scopeAssetInstanceId: uuid('scope_asset_instance_id').references(
      () => assetInstances.id,
      { onDelete: 'cascade' },
    ),
    // ---------- Procedure document template metadata (v3) ----------
    // Author-controlled fixed-section toggles + body content for the
    // template applied at render time. Only meaningful when
    // kind='structured_procedure'. Schema is jsonb (typed) rather than
    // separate columns because the surface is procedure-specific and
    // the doc table is shared across all kinds.
    //
    // Shape:
    //   {
    //     toolsRequired: string[],
    //     safety: { enabled: boolean, notes: string | null },
    //     verification: { enabled: boolean, notes: string | null },
    //   }
    procedureMetadata: jsonb('procedure_metadata')
      .$type<ProcedureDocMetadata | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packIdx: index('documents_pack_version_idx').on(t.contentPackVersionId),
    locGroupIdx: index('documents_localization_group_idx').on(t.localizationGroupId),
    // For the instance-scope filter on the PWA docs query.
    scopeInstanceIdx: index('documents_scope_instance_idx').on(t.scopeAssetInstanceId),
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
