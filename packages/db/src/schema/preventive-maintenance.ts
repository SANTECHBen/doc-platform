import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { assetModels, assetInstances } from './assets';
import { documents } from './content';
import { procedureRuns } from './procedures';
import { users } from './users';

// Preventive Maintenance.
//
// Two tables. PM Schedule = the *plan* (every N days run procedure X on this
// model). PM Service Record = the *fact* (a tech performed it on this
// instance at this time). The "due now / overdue / coming up" view is
// derived at query time from (schedule, latest service record per
// instance) — no stored "next_due_at" column to drift out of sync.
//
// v1 cadence is calendar-only. The cadence_kind enum is plural so we can
// add 'runtime_hours' or 'cycles' later without breaking the API contract.

export const pmCadenceKindEnum = pgEnum('pm_cadence_kind', [
  // Every N calendar days from the anchor (last performed_at, falling
  // back to the instance.installed_at, falling back to the schedule's
  // own created_at when neither is set).
  'days',
]);

export const pmSchedules = pgTable(
  'pm_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // PM plans hang off the asset model SKU. Every instance of that model
    // inherits every schedule the model has. Cascading on model delete is
    // intentional — a deleted model has no remaining instances anyway.
    assetModelId: uuid('asset_model_id')
      .notNull()
      .references(() => assetModels.id, { onDelete: 'cascade' }),
    // The procedure to run for this PM. We allow set-null because a
    // procedure document can be re-versioned / replaced; the schedule
    // shouldn't break and the admin can re-attach.
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    // Human label shown in admin and PWA — "Quarterly belt inspection".
    name: text('name').notNull(),
    description: text('description'),
    cadenceKind: pmCadenceKindEnum('cadence_kind').notNull().default('days'),
    // For cadence_kind='days', this is the number of days between
    // performances. Must be > 0; enforced by API zod schema (the DB
    // doesn't enforce positivity; we keep that in the application
    // layer to match the rest of the schema).
    cadenceValue: integer('cadence_value').notNull(),
    // Days late beyond next_due before status flips from 'due' to
    // 'overdue'. 0 means "overdue immediately on the due date".
    graceDays: integer('grace_days').notNull().default(0),
    // Soft toggle so the admin can pause a schedule without deleting
    // it (and losing the history of past records that referenced it).
    disabled: boolean('disabled').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    modelIdx: index('pm_schedules_asset_model_idx').on(t.assetModelId),
  }),
);

// Append-only per-instance log. Created either when a tech runs the PM's
// procedure to completion (server links procedure_run_id) or when an
// admin retroactively logs a service that happened off-platform.
//
// onDelete patterns:
//  - assetInstanceId cascade: history is meaningless without the instance.
//  - pmScheduleId set null: schedule deletion shouldn't erase compliance
//    history; record survives as "ad-hoc service".
//  - documentId set null + procedureRunId set null: links to authoring
//    artifacts that may rotate; record itself is the system of record.
//  - performedByUserId set null: anonymous PWA scan-session writes
//    leave this null and render as "Field tech" in History. When a
//    user is attached and later deleted, we drop the link rather than
//    purging compliance history — the record itself is the audit
//    artifact and stays valid without the performer.
export const pmServiceRecords = pgTable(
  'pm_service_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetInstanceId: uuid('asset_instance_id')
      .notNull()
      .references(() => assetInstances.id, { onDelete: 'cascade' }),
    pmScheduleId: uuid('pm_schedule_id').references(() => pmSchedules.id, {
      onDelete: 'set null',
    }),
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    procedureRunId: uuid('procedure_run_id').references(() => procedureRuns.id, {
      onDelete: 'set null',
    }),
    performedByUserId: uuid('performed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    performedAt: timestamp('performed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Hot path: "what's the latest record for (instance, schedule)?"
    instanceScheduleIdx: index('pm_service_records_instance_schedule_idx').on(
      t.assetInstanceId,
      t.pmScheduleId,
      t.performedAt,
    ),
    instancePerformedIdx: index('pm_service_records_instance_performed_idx').on(
      t.assetInstanceId,
      t.performedAt,
    ),
  }),
);

export const pmSchedulesRelations = relations(pmSchedules, ({ one, many }) => ({
  assetModel: one(assetModels, {
    fields: [pmSchedules.assetModelId],
    references: [assetModels.id],
  }),
  document: one(documents, {
    fields: [pmSchedules.documentId],
    references: [documents.id],
  }),
  serviceRecords: many(pmServiceRecords),
}));

export const pmServiceRecordsRelations = relations(
  pmServiceRecords,
  ({ one }) => ({
    assetInstance: one(assetInstances, {
      fields: [pmServiceRecords.assetInstanceId],
      references: [assetInstances.id],
    }),
    schedule: one(pmSchedules, {
      fields: [pmServiceRecords.pmScheduleId],
      references: [pmSchedules.id],
    }),
    document: one(documents, {
      fields: [pmServiceRecords.documentId],
      references: [documents.id],
    }),
    procedureRun: one(procedureRuns, {
      fields: [pmServiceRecords.procedureRunId],
      references: [procedureRuns.id],
    }),
    performedBy: one(users, {
      fields: [pmServiceRecords.performedByUserId],
      references: [users.id],
    }),
  }),
);

export type PmSchedule = typeof pmSchedules.$inferSelect;
export type NewPmSchedule = typeof pmSchedules.$inferInsert;
export type PmServiceRecord = typeof pmServiceRecords.$inferSelect;
export type NewPmServiceRecord = typeof pmServiceRecords.$inferInsert;

// ---------------------------------------------------------------------------
// PM Plans — checklist-style maintenance plans with per-row frequency.
// ---------------------------------------------------------------------------
//
// Distinct from pm_schedules (flat "every N days run procedure X") which
// stays as-is. A PM Plan models an OEM-style table like:
//
//   Component        Check                       Remarks               Freq
//   Floor frame      Check for plastic dust      Indicates misalignment  D
//   Entire splitter  Check for general damage    Observe in operation    W
//   Roller belt      Check for proper engagement Adjust per 2.2          M
//
// Each row (pm_plan_item) has its own frequency. The PWA presents one
// card per (plan, frequency) — "Daily checks (3 items)" — that expands
// to the per-row checklist. Tech taps "Mark performed" once for the whole
// frequency-bucket; we insert one pm_plan_service_record and the next-due
// recomputes from MAX(performed_at) per (plan, freq, instance).

export const pmPlanFrequencyEnum = pgEnum('pm_plan_frequency', [
  'D', // daily
  'W', // weekly
  'M', // monthly
  'Q', // quarterly
  'S', // semi-annually
  'Y', // yearly
]);

export const pmPlans = pgTable(
  'pm_plans',
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
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    modelIdx: index('pm_plans_asset_model_idx').on(t.assetModelId),
  }),
);

export const pmPlanItems = pgTable(
  'pm_plan_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => pmPlans.id, { onDelete: 'cascade' }),
    component: text('component').notNull(),
    checkText: text('check_text').notNull(),
    remarks: text('remarks'),
    frequency: pmPlanFrequencyEnum('frequency').notNull(),
    // Optional Job Aid for this row. Tech tapping a row with document_id
    // launches the procedure; rows without one are reminder-only and just
    // get acknowledged when the frequency-bucket is marked performed.
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    orderingHint: integer('ordering_hint').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    planIdx: index('pm_plan_items_plan_idx').on(t.planId),
    planOrderIdx: index('pm_plan_items_plan_order_idx').on(
      t.planId,
      t.orderingHint,
    ),
    planFreqIdx: index('pm_plan_items_plan_frequency_idx').on(
      t.planId,
      t.frequency,
    ),
  }),
);

export const pmPlanServiceRecords = pgTable(
  'pm_plan_service_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetInstanceId: uuid('asset_instance_id')
      .notNull()
      .references(() => assetInstances.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id').references(() => pmPlans.id, {
      onDelete: 'set null',
    }),
    frequency: pmPlanFrequencyEnum('frequency').notNull(),
    // Nullable to support anonymous PWA scan-session writes. See
    // pmServiceRecords for the same pattern + reasoning.
    performedByUserId: uuid('performed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    performedAt: timestamp('performed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    instancePlanFreqIdx: index('pm_plan_service_records_instance_plan_freq_idx')
      .on(t.assetInstanceId, t.planId, t.frequency, t.performedAt),
    instancePerformedIdx: index('pm_plan_service_records_instance_performed_idx')
      .on(t.assetInstanceId, t.performedAt),
  }),
);

export const pmPlansRelations = relations(pmPlans, ({ one, many }) => ({
  assetModel: one(assetModels, {
    fields: [pmPlans.assetModelId],
    references: [assetModels.id],
  }),
  items: many(pmPlanItems),
  serviceRecords: many(pmPlanServiceRecords),
}));

export const pmPlanItemsRelations = relations(pmPlanItems, ({ one }) => ({
  plan: one(pmPlans, {
    fields: [pmPlanItems.planId],
    references: [pmPlans.id],
  }),
  document: one(documents, {
    fields: [pmPlanItems.documentId],
    references: [documents.id],
  }),
}));

export const pmPlanServiceRecordsRelations = relations(
  pmPlanServiceRecords,
  ({ one }) => ({
    assetInstance: one(assetInstances, {
      fields: [pmPlanServiceRecords.assetInstanceId],
      references: [assetInstances.id],
    }),
    plan: one(pmPlans, {
      fields: [pmPlanServiceRecords.planId],
      references: [pmPlans.id],
    }),
    performedBy: one(users, {
      fields: [pmPlanServiceRecords.performedByUserId],
      references: [users.id],
    }),
  }),
);

export type PmPlanFrequency = (typeof pmPlanFrequencyEnum.enumValues)[number];
export type PmPlan = typeof pmPlans.$inferSelect;
export type NewPmPlan = typeof pmPlans.$inferInsert;
export type PmPlanItem = typeof pmPlanItems.$inferSelect;
export type NewPmPlanItem = typeof pmPlanItems.$inferInsert;
export type PmPlanServiceRecord = typeof pmPlanServiceRecords.$inferSelect;
export type NewPmPlanServiceRecord = typeof pmPlanServiceRecords.$inferInsert;

/** Cadence days for a frequency code — used by both the API status
 *  calculator and the PWA's "next due" math. Edit here once. */
export const PM_PLAN_FREQUENCY_DAYS: Record<PmPlanFrequency, number> = {
  D: 1,
  W: 7,
  M: 30,
  Q: 90,
  S: 180,
  Y: 365,
};

/** Human-friendly label for a frequency code, used wherever we'd render
 *  the raw enum to a user. */
export const PM_PLAN_FREQUENCY_LABEL: Record<PmPlanFrequency, string> = {
  D: 'Daily',
  W: 'Weekly',
  M: 'Monthly',
  Q: 'Quarterly',
  S: 'Semi-annually',
  Y: 'Yearly',
};
