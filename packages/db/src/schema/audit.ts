import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { organizations } from './organizations';

// Append-only audit log. Safety-critical compliance requires provable answers to
// "who saw what version of which procedure, on which equipment, at what time".
// Do not soft-delete. Do not update. Append only.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Free-form event name (e.g., "document.viewed", "content_pack.published").
    eventType: text('event_type').notNull(),
    // Canonical entity this event is about.
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    // Structured payload. Keep small; put large bodies elsewhere and reference.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgTimeIdx: index('audit_events_org_time_idx').on(t.organizationId, t.occurredAt),
    targetIdx: index('audit_events_target_idx').on(t.targetType, t.targetId),
    eventTypeIdx: index('audit_events_event_type_idx').on(t.eventType),
  }),
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
