import { pgTable, uuid, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizationTypeEnum } from './enums';

// An Organization is a tenant. Type drives capability:
//   oem           → can author base ContentPacks, owns AssetModels it manufactures.
//   dealer        → can overlay an OEM's ContentPack for its end-customer sites.
//   integrator    → like dealer, typically a systems integrator (Bastian, Fortna).
//   end_customer  → consumes content at its sites; cannot author base content.
//
// The parentOrganizationId models the resale chain:
//   Dematic (oem) → Bastian (integrator) → Acme Logistics (end_customer)
// A dealer/integrator/end_customer MUST have a parent (the upstream in the chain).
// OEMs have no parent.
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: organizationTypeEnum('type').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  parentOrganizationId: uuid('parent_organization_id').references(
    (): any => organizations.id,
    { onDelete: 'restrict' },
  ),
  // OEM-specific: the canonical vendor code used by content authors.
  oemCode: text('oem_code'),
  // Branding — applied to the PWA when this org (or a descendant asset model)
  // owns the scanned equipment. Technicians see the OEM's brand, not ours.
  brandPrimary: text('brand_primary'),          // "#F77531" — hex
  brandOnPrimary: text('brand_on_primary'),     // text color on primary — hex
  logoStorageKey: text('logo_storage_key'),     // uploaded wordmark
  displayNameOverride: text('display_name_override'), // overrides "Equipment Hub"
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  // When true, the PWA requires a valid scan-session cookie to show asset
  // content. A cookie is minted when a user lands on /q/<code> (which is
  // where QR codes point); it's bound to the code and short-lived (8h).
  // Anyone who lands on /a/<code> without a matching cookie sees a
  // "scan this equipment's QR code to continue" wall.
  //
  // This is an opt-in privacy setting, typically flipped on by end-customer
  // orgs that don't want the asset content viewable by anyone with the URL.
  requireScanAccess: boolean('require_scan_access').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  parent: one(organizations, {
    fields: [organizations.parentOrganizationId],
    references: [organizations.id],
    relationName: 'org_parent',
  }),
  children: many(organizations, { relationName: 'org_parent' }),
}));

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
