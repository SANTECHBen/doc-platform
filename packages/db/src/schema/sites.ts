import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';

// A Site is a physical facility owned by an end-customer org (e.g., "Memphis DC 3").
// Sites scope asset instances, memberships, and content overlays.
export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code'),
  addressLine1: text('address_line_1'),
  addressLine2: text('address_line_2'),
  city: text('city'),
  region: text('region'),
  postalCode: text('postal_code'),
  country: text('country'),
  timezone: text('timezone').notNull().default('UTC'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sitesRelations = relations(sites, ({ one }) => ({
  organization: one(organizations, {
    fields: [sites.organizationId],
    references: [organizations.id],
  }),
}));

export type Site = typeof sites.$inferSelect;
export type NewSite = typeof sites.$inferInsert;
