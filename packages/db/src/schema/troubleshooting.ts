import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { assetModels } from './assets';
import { documents } from './content';
import { users } from './users';

// Troubleshooting guides — OEM-style triage tables (Symptom / Cause /
// Remedy) for a piece of equipment. Modeled after pm_plans so the admin
// authoring grid + PWA rendering can reuse the same patterns. Distinct
// from pm_schedules (scheduled work) and pm_plans (recurring checklists)
// in that troubleshooting is reactive: the tech has a problem, looks it
// up by symptom, follows the remedy. No service records, no due dates.

export const troubleshootingGuides = pgTable(
  'troubleshooting_guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetModelId: uuid('asset_model_id')
      .notNull()
      .references(() => assetModels.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    orderingHint: integer('ordering_hint').notNull().default(0),
    disabled: boolean('disabled').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modelIdx: index('troubleshooting_guides_asset_model_idx').on(t.assetModelId),
  }),
);

export const troubleshootingItems = pgTable(
  'troubleshooting_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guideId: uuid('guide_id')
      .notNull()
      .references(() => troubleshootingGuides.id, { onDelete: 'cascade' }),
    symptom: text('symptom').notNull(),
    cause: text('cause'),
    remedy: text('remedy'),
    // Optional Job Aid the tech can launch from the PWA when this row
    // matches their problem. Set null on delete so removing the linked
    // procedure clears the link rather than nuking the triage row.
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    orderingHint: integer('ordering_hint').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guideIdx: index('troubleshooting_items_guide_idx').on(t.guideId),
    guideOrderIdx: index('troubleshooting_items_guide_order_idx').on(
      t.guideId,
      t.orderingHint,
    ),
  }),
);

export const troubleshootingGuidesRelations = relations(
  troubleshootingGuides,
  ({ one, many }) => ({
    assetModel: one(assetModels, {
      fields: [troubleshootingGuides.assetModelId],
      references: [assetModels.id],
    }),
    items: many(troubleshootingItems),
  }),
);

export const troubleshootingItemsRelations = relations(
  troubleshootingItems,
  ({ one }) => ({
    guide: one(troubleshootingGuides, {
      fields: [troubleshootingItems.guideId],
      references: [troubleshootingGuides.id],
    }),
    document: one(documents, {
      fields: [troubleshootingItems.documentId],
      references: [documents.id],
    }),
  }),
);

export type TroubleshootingGuide = typeof troubleshootingGuides.$inferSelect;
export type NewTroubleshootingGuide = typeof troubleshootingGuides.$inferInsert;
export type TroubleshootingItem = typeof troubleshootingItems.$inferSelect;
export type NewTroubleshootingItem = typeof troubleshootingItems.$inferInsert;
