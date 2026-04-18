import { pgTable, uuid, text, timestamp, boolean, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { sites } from './sites';
import { roleEnum } from './enums';

// Users belong to a "home" Organization but can hold Memberships in multiple orgs
// (common for dealer technicians who serve multiple end-customer sites, or SMEs
// contracted by an OEM).
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  homeOrganizationId: uuid('home_organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  workosUserId: text('workos_user_id').unique(),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Membership binds a user to an org with a role, optionally scoped to a specific site.
// A null siteId means the role applies org-wide.
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserOrgSiteRole: unique().on(t.userId, t.organizationId, t.siteId, t.role),
  }),
);

export const usersRelations = relations(users, ({ one, many }) => ({
  homeOrganization: one(organizations, {
    fields: [users.homeOrganizationId],
    references: [organizations.id],
  }),
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  site: one(sites, { fields: [memberships.siteId], references: [sites.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
