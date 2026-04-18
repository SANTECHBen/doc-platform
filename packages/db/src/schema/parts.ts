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
import { contentPackVersions } from './content';

// A Part is catalog metadata, owned by an OEM. Sharable across models via BomEntry.
export const parts = pgTable(
  'parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // OEM's authoritative part number.
    oemPartNumber: text('oem_part_number').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    // Cross-references to aftermarket/alternative part numbers.
    crossReferences: jsonb('cross_references').$type<string[]>().notNull().default([]),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    // Where the part image lives, if any.
    imageStorageKey: text('image_storage_key'),
    // Discontinued parts still need to be findable from legacy QR codes/docs.
    discontinued: boolean('discontinued').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqOwnerPart: unique().on(t.ownerOrganizationId, t.oemPartNumber),
  }),
);

// BomEntry: membership of a part in an AssetModel's bill of materials.
// Same part can belong to many models; same model contains many parts.
export const bomEntries = pgTable(
  'bom_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetModelId: uuid('asset_model_id')
      .notNull()
      .references(() => assetModels.id, { onDelete: 'cascade' }),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'restrict' }),
    // A stable identifier within the BOM (e.g., "E-217" on an electrical schematic).
    positionRef: text('position_ref'),
    quantity: integer('quantity').notNull().default(1),
    notes: text('notes'),
  },
  (t) => ({
    uniqModelPartPosition: unique().on(t.assetModelId, t.partId, t.positionRef),
    assetIdx: index('bom_entries_asset_idx').on(t.assetModelId),
  }),
);

// PartReference: a callout to a Part from within a ContentPack version.
// Used by procedures and training modules to link "see part E-217".
export const partReferences = pgTable('part_references', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentPackVersionId: uuid('content_pack_version_id')
    .notNull()
    .references(() => contentPackVersions.id, { onDelete: 'cascade' }),
  partId: uuid('part_id')
    .notNull()
    .references(() => parts.id, { onDelete: 'restrict' }),
  context: text('context'),
});

export const partsRelations = relations(parts, ({ one, many }) => ({
  owner: one(organizations, {
    fields: [parts.ownerOrganizationId],
    references: [organizations.id],
  }),
  bomEntries: many(bomEntries),
}));

export const bomEntriesRelations = relations(bomEntries, ({ one }) => ({
  assetModel: one(assetModels, {
    fields: [bomEntries.assetModelId],
    references: [assetModels.id],
  }),
  part: one(parts, { fields: [bomEntries.partId], references: [parts.id] }),
}));

export type Part = typeof parts.$inferSelect;
export type BomEntry = typeof bomEntries.$inferSelect;
export type PartReference = typeof partReferences.$inferSelect;
