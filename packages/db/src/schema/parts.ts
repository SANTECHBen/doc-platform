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
import { contentPackVersions, documents } from './content';
import { trainingModules } from './training';

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

// PartDocument: explicit authored link between a Part and a Document within
// a ContentPackVersion. Authoring granularity is deliberately per-version
// (not per-Part global) — a doc only exists inside its version, and OEMs
// routinely revise which docs apply to a part as hardware revisions land.
// Cascade on delete from either side so a removed doc or part cleans up.
export const partDocuments = pgTable(
  'part_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPartDoc: unique().on(t.partId, t.documentId),
    partIdx: index('part_documents_part_idx').on(t.partId),
    docIdx: index('part_documents_document_idx').on(t.documentId),
  }),
);

// PartTrainingModule: same pattern, linking a Part to a TrainingModule
// inside a ContentPackVersion. Lets technicians open part → "Replacement
// training for this specific unit".
export const partTrainingModules = pgTable(
  'part_training_modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partId: uuid('part_id')
      .notNull()
      .references(() => parts.id, { onDelete: 'cascade' }),
    trainingModuleId: uuid('training_module_id')
      .notNull()
      .references(() => trainingModules.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqPartModule: unique().on(t.partId, t.trainingModuleId),
    partIdx: index('part_training_modules_part_idx').on(t.partId),
    moduleIdx: index('part_training_modules_module_idx').on(t.trainingModuleId),
  }),
);

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
export type PartDocument = typeof partDocuments.$inferSelect;
export type PartTrainingModule = typeof partTrainingModules.$inferSelect;
