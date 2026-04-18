import { pgTable, uuid, text, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { sites } from './sites';
import { contentPackVersions } from './content';

// AssetModel = the equipment SKU. Authored once by the owning OEM.
// AssetInstance = the serial-numbered unit at a customer site. QR codes resolve here.
//
// Content is authored against AssetModel; users interact with AssetInstance.
// This separation is the core of the equipment-centric platform.
export const assetModels = pgTable(
  'asset_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // Manufacturer-assigned model identifier (e.g., "RapidStore-MS-G4").
    modelCode: text('model_code').notNull(),
    displayName: text('display_name').notNull(),
    // Broad equipment family for filtering/analytics (e.g., "asrs", "conveyor", "agv").
    category: text('category').notNull(),
    description: text('description'),
    // Hero photo shown on the PWA asset hub and admin tiles. One image per
    // model SKU (installed units share it). Uploaded via the admin.
    imageStorageKey: text('image_storage_key'),
    specifications: jsonb('specifications')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOwnerCode: unique().on(t.ownerOrganizationId, t.modelCode),
    categoryIdx: index('asset_models_category_idx').on(t.category),
  }),
);

export const assetInstances = pgTable(
  'asset_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetModelId: uuid('asset_model_id')
      .notNull()
      .references(() => assetModels.id, { onDelete: 'restrict' }),
    // The end-customer site where this unit is installed.
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    serialNumber: text('serial_number').notNull(),
    // The pinned ContentPack version this instance is currently rendering.
    // Updating this is the "rollout" action — audited, typically done per-site.
    pinnedContentPackVersionId: uuid('pinned_content_pack_version_id').references(
      () => contentPackVersions.id,
      { onDelete: 'set null' },
    ),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqModelSerial: unique().on(t.assetModelId, t.serialNumber),
    siteIdx: index('asset_instances_site_idx').on(t.siteId),
  }),
);

export const assetModelsRelations = relations(assetModels, ({ one, many }) => ({
  owner: one(organizations, {
    fields: [assetModels.ownerOrganizationId],
    references: [organizations.id],
  }),
  instances: many(assetInstances),
}));

export const assetInstancesRelations = relations(assetInstances, ({ one }) => ({
  model: one(assetModels, {
    fields: [assetInstances.assetModelId],
    references: [assetModels.id],
  }),
  site: one(sites, { fields: [assetInstances.siteId], references: [sites.id] }),
  pinnedContentPackVersion: one(contentPackVersions, {
    fields: [assetInstances.pinnedContentPackVersionId],
    references: [contentPackVersions.id],
  }),
}));

export type AssetModel = typeof assetModels.$inferSelect;
export type NewAssetModel = typeof assetModels.$inferInsert;
export type AssetInstance = typeof assetInstances.$inferSelect;
export type NewAssetInstance = typeof assetInstances.$inferInsert;
