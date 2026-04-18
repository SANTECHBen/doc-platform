import { pgTable, uuid, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { assetInstances } from './assets';

// A QrCode encodes an opaque short ID (not a serial number, not a URL with PII).
// Resolution is server-side, which means QR stickers can be:
//   - re-targeted to a different asset instance if equipment is replaced
//   - revoked if a sticker is stolen or compromised
//   - audited at scan time (see audit_events)
// The printed sticker contains a URL like:
//   https://<public-pwa-origin>/q/<code>
//
// `code` is a short, URL-safe string (e.g., base32, 10–12 chars) generated server-side.
export const qrCodes = pgTable(
  'qr_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    assetInstanceId: uuid('asset_instance_id').references(() => assetInstances.id, {
      onDelete: 'set null',
    }),
    // Labels visible to admins on the sticker management page.
    label: text('label'),
    active: boolean('active').notNull().default(true),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('qr_codes_active_idx').on(t.active),
  }),
);

export const qrCodesRelations = relations(qrCodes, ({ one }) => ({
  assetInstance: one(assetInstances, {
    fields: [qrCodes.assetInstanceId],
    references: [assetInstances.id],
  }),
}));

export type QrCode = typeof qrCodes.$inferSelect;
export type NewQrCode = typeof qrCodes.$inferInsert;
