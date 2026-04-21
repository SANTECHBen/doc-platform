import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';

// Per-org reusable designs for printed QR stickers. The print page applies
// a chosen template to the selected codes — each row here is one saved
// design. Field-level toggles let an admin hide auto-populated fields
// (e.g., "don't print the site name on factory-floor stickers") and
// override labels ("S/N" → "Machine ID"). Layout picks an on-page
// composition; the rest is styling + content slots.
//
// Kept deliberately wide (one row per template) rather than normalized
// across a separate fields table — templates are configuration data
// touched infrequently, and JSONB here keeps the renderer simple.
export const qrLabelTemplates = pgTable(
  'qr_label_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // One template per org can be the default (picked automatically on the
    // print page when no template is selected). Null = no default; only one
    // template per org should have is_default=true — enforced at the app
    // level on upsert since partial unique indexes need careful handling.
    isDefault: boolean('is_default').notNull().default(false),

    // Layout preset. Each preset has a fixed slot composition; the fields
    // object below controls which slots are populated.
    //   'nameplate' — current industrial style (border, brand rail, footer)
    //   'minimal'   — QR-dominant, just a small ident block
    //   'safety'    — yellow/black high-visibility hazard-class
    layout: text('layout', {
      enum: ['nameplate', 'minimal', 'safety'],
    }).notNull().default('nameplate'),

    // Accent color (hex). Drives the brand rail, footer rules, and serial
    // value tint depending on the layout.
    accentColor: text('accent_color').notNull().default('#0B5FBF'),

    // Optional logo storage key. Rendered in the header strip when present.
    logoStorageKey: text('logo_storage_key'),

    // QR rendering — error correction matters when a logo overlays the
    // code. H tolerates ~30% occlusion; M is our default (about 15%).
    qrSize: integer('qr_size').notNull().default(92),
    qrErrorCorrection: text('qr_error_correction', {
      enum: ['L', 'M', 'Q', 'H'],
    })
      .notNull()
      .default('M'),

    // Fields JSON — the complete set of text slots with enable + optional
    // overrides. Shape:
    //   {
    //     header: { enabled, text },          // custom static header text
    //     model: { enabled, labelOverride },  // auto: asset model display
    //     serial: { enabled, labelOverride }, // auto: asset serial
    //     site: { enabled, labelOverride },   // auto: site name
    //     location: { enabled, labelOverride },// auto: QR label (loc)
    //     description: { enabled, text },     // custom free-form description
    //     idCode: { enabled, labelOverride }, // auto: QR short code
    //   }
    // Unknown future fields can be added without a migration — code that
    // reads this should default missing keys to { enabled: false }.
    fields: jsonb('fields').notNull(),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('qr_label_templates_org_idx').on(t.organizationId),
  }),
);

export const qrLabelTemplatesRelations = relations(qrLabelTemplates, ({ one }) => ({
  organization: one(organizations, {
    fields: [qrLabelTemplates.organizationId],
    references: [organizations.id],
  }),
  createdBy: one(users, {
    fields: [qrLabelTemplates.createdByUserId],
    references: [users.id],
  }),
}));

export type QrLabelTemplate = typeof qrLabelTemplates.$inferSelect;
export type NewQrLabelTemplate = typeof qrLabelTemplates.$inferInsert;

// Canonical shape of the fields column. Kept here (not in @platform/shared)
// because the schema package already has no client-facing surface — editor
// and renderer import from here.
export interface QrLabelTemplateFields {
  header: { enabled: boolean; text: string };
  model: { enabled: boolean; labelOverride: string | null };
  serial: { enabled: boolean; labelOverride: string | null };
  site: { enabled: boolean; labelOverride: string | null };
  location: { enabled: boolean; labelOverride: string | null };
  description: { enabled: boolean; text: string };
  idCode: { enabled: boolean; labelOverride: string | null };
}

export const DEFAULT_TEMPLATE_FIELDS: QrLabelTemplateFields = {
  header: { enabled: false, text: '' },
  model: { enabled: true, labelOverride: null },
  serial: { enabled: true, labelOverride: null },
  site: { enabled: true, labelOverride: null },
  location: { enabled: true, labelOverride: null },
  description: { enabled: false, text: '' },
  idCode: { enabled: true, labelOverride: 'ID' },
};
