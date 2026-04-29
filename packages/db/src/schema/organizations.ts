import { pgTable, uuid, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizationTypeEnum } from './enums';

// An Organization is a tenant. Type drives capability:
//   oem           → can author base ContentPacks, owns AssetModels it manufactures.
//   dealer        → can overlay an OEM's ContentPack for its end-customer sites.
//   integrator    → systems integrator that combines equipment from many OEMs at
//                   end-customer sites (e.g., Western Industrial, Bastian, Fortna).
//                   Can author dealer_overlay packs targeting any OEM's base pack.
//   end_customer  → consumes content at its sites; cannot author base content.
//
// parentOrganizationId models the *single contractual / service chain* — who you
// call when something breaks, who can author overlays for this org. NOT a model
// of "which OEM's equipment is on site" (that's tracked through asset_models →
// asset_instances → sites, which is many-to-many between OEMs and end-customers).
//
// Parent rules:
//   oem         — no parent. They're top-level by definition.
//   integrator  — usually no parent. Independent companies that work with many
//                 OEMs and don't sit "under" any single one. Optional in the API.
//   dealer      — usually no parent (multi-OEM resellers) or one OEM parent
//                 (captive dealers). Optional in the API.
//   end_customer — required parent: whoever installed/services them (typically
//                 the integrator, or the OEM directly if no middleman).
//
// Example (the SANTECH FedEx case):
//   FedEx (end_customer)
//     parent → Western Industrial (integrator, no parent)
//   Equipment from Flow-Turn, Honeywell, Intralox, SICK is associated to FedEx
//   via asset_instances at FedEx's sites — not via parent chains.
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
  // Microsoft Entra tenant ID that maps to this org. When a user signs in
  // via Microsoft with a matching `tid` claim, their home org is set to
  // this row. Null = not linked to any Microsoft tenant (e.g., SANTECH
  // internal orgs for platform admins). Unique: one tenant = one org.
  msftTenantId: text('msft_tenant_id').unique(),
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
