import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { assetInstances } from './assets';
import { users } from './users';
import { workOrderStatusEnum, workOrderSeverityEnum } from './enums';

// A WorkOrder is opened from the asset hub ("Report Issue") and can be synced to
// the customer's CMMS (UpKeep, Fiix, Maximo) via webhooks in Phase 2.
export const workOrders = pgTable(
  'work_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetInstanceId: uuid('asset_instance_id')
      .notNull()
      .references(() => assetInstances.id, { onDelete: 'restrict' }),
    openedByUserId: uuid('opened_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: workOrderStatusEnum('status').notNull().default('open'),
    severity: workOrderSeverityEnum('severity').notNull().default('medium'),
    title: text('title').notNull(),
    description: text('description'),
    // Attached media (photo/video pointers in S3).
    attachments: jsonb('attachments')
      .$type<Array<{ key: string; mime: string; caption?: string }>>()
      .notNull()
      .default([]),
    // External CMMS reference (e.g., UpKeep work order number) for round-trip sync.
    externalRef: text('external_ref'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    assetIdx: index('work_orders_asset_idx').on(t.assetInstanceId),
    statusIdx: index('work_orders_status_idx').on(t.status),
  }),
);

export const workOrdersRelations = relations(workOrders, ({ one }) => ({
  assetInstance: one(assetInstances, {
    fields: [workOrders.assetInstanceId],
    references: [assetInstances.id],
  }),
  openedBy: one(users, {
    fields: [workOrders.openedByUserId],
    references: [users.id],
    relationName: 'wo_opened',
  }),
  assignedTo: one(users, {
    fields: [workOrders.assignedToUserId],
    references: [users.id],
    relationName: 'wo_assigned',
  }),
}));

export type WorkOrder = typeof workOrders.$inferSelect;
export type NewWorkOrder = typeof workOrders.$inferInsert;
