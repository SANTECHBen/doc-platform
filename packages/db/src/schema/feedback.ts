import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { assetInstances } from './assets';
import { organizations } from './organizations';

// Beta feedback channel — captured from the PWA's "Send feedback" widget.
// Anonymous-friendly (PWA scans don't have a user identity), so user fields
// are not stored. Routes 1:1 to the feedback inbox at SANTECH; optionally
// forwarded to Slack via FEEDBACK_SLACK_WEBHOOK env var on the API.
export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submittedAt: timestamp('submitted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Optional: tied to a specific asset instance if the tech was on an
    // asset hub when they submitted. Nullable so general PWA feedback
    // (e.g., "the scanner is slow") still lands.
    assetInstanceId: uuid('asset_instance_id').references(() => assetInstances.id, {
      onDelete: 'set null',
    }),
    // Optional: the QR code the tech scanned. Useful for tracing if the
    // asset_instance_id is missing or stale.
    qrCode: text('qr_code'),
    // Optional: derived from scan-session scope at submit time. Lets us
    // segment feedback per beta participant tenant.
    orgId: uuid('org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    // Free-form category choice from the widget. Kept as text (not enum)
    // so we can iterate categories during beta without a migration.
    category: text('category').notNull(),
    message: text('message').notNull(),
    // Diagnostic context.
    browserUa: text('browser_ua'),
    viewport: jsonb('viewport').$type<{ w: number; h: number } | null>(),
    appVersion: text('app_version'),
    // Optional contact info if the tech wants a follow-up.
    contactEmail: text('contact_email'),
  },
  (t) => ({
    submittedIdx: index('feedback_submitted_idx').on(t.submittedAt),
    orgIdx: index('feedback_org_idx').on(t.orgId),
  }),
);

export const feedbackRelations = relations(feedback, ({ one }) => ({
  assetInstance: one(assetInstances, {
    fields: [feedback.assetInstanceId],
    references: [assetInstances.id],
  }),
  org: one(organizations, {
    fields: [feedback.orgId],
    references: [organizations.id],
  }),
}));

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
