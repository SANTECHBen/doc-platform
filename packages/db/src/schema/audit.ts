import { pgTable, uuid, text, timestamp, jsonb, index, bigint } from 'drizzle-orm/pg-core';
import { users } from './users';
import { organizations } from './organizations';

// Append-only audit log. Safety-critical compliance requires provable answers to
// "who saw what version of which procedure, on which equipment, at what time".
// Do not soft-delete. Do not update. Append only.
//
// Tamper-evidence is enforced at the DATABASE level (migration
// 0049_audit_integrity.sql), not just by convention:
//   - `seq` gives a per-table monotonic order.
//   - `prevHash`/`rowHash` form a per-org SHA-256 hash chain, maintained by a
//     BEFORE INSERT trigger. Any edit, delete, or reorder breaks the chain and
//     is detectable via the audit_events_verify() function.
//   - A BEFORE UPDATE/DELETE trigger rejects all mutations, so the log is
//     immutable regardless of which role connects.
// seq/prevHash/rowHash are populated by the trigger — application inserts must
// NOT supply them (they are nullable here precisely so inserts omit them).
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Monotonic chain order, assigned by a bigserial default in the DB. Used
    // as the keyset-pagination cursor and the hash-chain ordering key.
    seq: bigint('seq', { mode: 'number' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Free-form event name (e.g., "document.viewed", "content_pack.published").
    // Constrained at the application boundary by the AuditEventType union in
    // @platform/api lib/audit.ts.
    eventType: text('event_type').notNull(),
    // Canonical entity this event is about.
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    // Structured payload. Keep small; put large bodies elsewhere and reference.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // Correlates every event emitted while handling one HTTP request.
    requestId: text('request_id'),
    // Tamper-evidence chain (trigger-maintained; never set by the app).
    prevHash: text('prev_hash'),
    rowHash: text('row_hash'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgTimeIdx: index('audit_events_org_time_idx').on(t.organizationId, t.occurredAt),
    targetIdx: index('audit_events_target_idx').on(t.targetType, t.targetId),
    eventTypeIdx: index('audit_events_event_type_idx').on(t.eventType),
    // Chain walk + keyset pagination within an org.
    orgSeqIdx: index('audit_events_org_seq_idx').on(t.organizationId, t.seq),
    // Global keyset-pagination cursor for the platform-admin "all orgs" view.
    seqIdx: index('audit_events_seq_idx').on(t.seq),
    actorIdx: index('audit_events_actor_idx').on(t.actorUserId),
    requestIdx: index('audit_events_request_idx').on(t.requestId),
  }),
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
