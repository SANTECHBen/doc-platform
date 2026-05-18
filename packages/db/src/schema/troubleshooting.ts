import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  jsonb,
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
    // Legacy free-text cause/remedy. Kept for back-compat with rows
    // authored before the structured items arrays landed. New authoring
    // uses causeItems / remedyItems; PWA only falls back to these when
    // the corresponding items array is empty.
    cause: text('cause'),
    remedy: text('remedy'),
    // DEPRECATED (kept on the table to avoid a destructive drop). The
    // 0027 model treated cause + remedy as independent parallel lists,
    // missing the OEM pairing where each cause has its own specific
    // remedy. Use `causes` below instead — admin UI + PWA only read/
    // write that field now.
    causeItems: jsonb('cause_items')
      .$type<Array<{ text: string; documentId?: string | null }>>()
      .notNull()
      .default([]),
    remedyItems: jsonb('remedy_items')
      .$type<Array<{ text: string; documentId?: string | null }>>()
      .notNull()
      .default([]),
    // Paired cause/remedy entries — the canonical structured shape.
    // Each item: one cause + its specific remedy + optional procedure
    // link. Matches the OEM mental model where a symptom has multiple
    // distinct causes each with their own fix.
    causes: jsonb('causes')
      .$type<
        Array<{
          cause: string;
          remedy: string;
          documentId?: string | null;
        }>
      >()
      .notNull()
      .default([]),
    // Row-level Job Aid fallback. Used when the entire remedy is "run
    // this one procedure"; per-item links in remedyItems override on a
    // step-by-step basis. Set null on delete clears the link rather
    // than nuking the triage row.
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
