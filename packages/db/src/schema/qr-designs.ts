import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';

// Saved QR designs from the /qr-codes/designer canvas — module shapes, eye
// styles, colors, embedded logos, frames, etc. Each row holds the full
// JSON spec the designer renders from, plus org + owner pointers.
//
// Storage shape: the `spec` JSONB is whatever the latest designer schema
// emits. We never read individual subfields server-side; the API treats
// it as opaque pass-through. Versioning future-proofs the column without
// a migration when the designer adds new style options — old specs render
// with the renderer's documented defaults for missing keys.
//
// Visibility: any user whose org scope contains `organization_id` can
// list / read the design. That's intentional — designs are reusable brand
// assets within the company, like label templates. Mutation/delete is
// further restricted at the route layer to the owner (or platform admin)
// to prevent accidental clobbering.
export const qrDesigns = pgTable(
  'qr_designs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Designs are owned by the user who saved them. If the user is later
    // deleted we keep the design (set null) — losing branded artwork because
    // the original author left the company would be surprising. The route
    // layer accepts null owners as "everyone can edit" for back-compat.
    ownerUserId: uuid('owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    // Full QrStyleSpec — opaque to the server. Embedded logos arrive as
    // data URIs inside this blob, which is why we cap the API body size at
    // a generous limit on the route layer. Postgres TOAST handles the
    // compression transparently.
    spec: jsonb('spec').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Listing is always org-scoped; sort by recency. A composite covers
    // both predicates without a sort step.
    orgUpdatedIdx: index('qr_designs_org_updated_idx').on(t.organizationId, t.updatedAt),
    ownerIdx: index('qr_designs_owner_idx').on(t.ownerUserId),
  }),
);

export const qrDesignsRelations = relations(qrDesigns, ({ one }) => ({
  organization: one(organizations, {
    fields: [qrDesigns.organizationId],
    references: [organizations.id],
  }),
  owner: one(users, {
    fields: [qrDesigns.ownerUserId],
    references: [users.id],
  }),
}));

export type QrDesign = typeof qrDesigns.$inferSelect;
export type NewQrDesign = typeof qrDesigns.$inferInsert;
