import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';

// Procedure step categories — author-extensible semantic tags applied to
// procedure_sections (drives the PWA phase-progress strip's color/icon)
// and individually to procedure_steps (drives an in-body badge on the
// step card).
//
// Two-tier ownership:
//   - Built-in categories live with organization_id = NULL. Seeded once
//     by the 0039 migration (Safety = yellow, Verification = green) and
//     visible to every org. Platform admins can edit them; org admins
//     cannot. They never get deleted because the migration would just
//     re-seed them on the next deploy.
//   - Org-specific categories live with organization_id = <orgId> and are
//     visible only to that org. Authors create these from the admin
//     "Step categories" manager when their docs need a category we
//     haven't built in (e.g., "Calibration", "Sign-off", "Customer
//     present").
//
// FK behavior on delete:
//   - procedure_sections.category_id → SET NULL (a category deletion
//     should not orphan or delete a section — the section just falls
//     back to neutral coloring).
//   - procedure_steps.category_id    → SET NULL (same rationale for
//     the per-step badge).
//
// Color is stored as a hex string (e.g. "#EAB308" for yellow-500). The
// PWA uses the value directly as a CSS color; the admin color picker
// constrains it to a small palette + a custom-hex input.
//
// Icon is a Lucide icon name (e.g. "shield-alert", "circle-check"). The
// renderer maps strings to icon components from a curated allowlist —
// arbitrary user input is treated as "no icon" rather than dynamically
// importing whatever Lucide ships (which would bloat the bundle).
export const procedureStepCategories = pgTable(
  'procedure_step_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = built-in / platform-wide. Otherwise an org's own custom
    // category. The application-level scope check enforces visibility:
    // a row is visible to a caller if organization_id IS NULL or matches
    // an org in the caller's scope.
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    // Human-readable label. Shown in admin pickers and used as the strip
    // label fallback when a section has no title of its own. Case-folded
    // uniqueness within the (org, NULL-for-builtins) scope — see partial
    // unique indexes below.
    name: text('name').notNull(),
    // CSS color string, typically a hex like "#EAB308". Validated in the
    // API as /^#[0-9a-fA-F]{6}$/. Stored as-is so the admin can roundtrip
    // arbitrary palette picks without a lookup table.
    color: text('color').notNull(),
    // Lucide icon name, e.g. "shield-alert". Renderer falls back to no
    // icon when the name is not in its allowlist. Optional.
    icon: text('icon'),
    // Sort order for the admin picker. Lower numbers render first. New
    // org categories append at the end with a 100-step gap so a single
    // reorder doesn't rewrite every row.
    sortOrder: integer('sort_order').notNull().default(0),
    // True iff seeded by the migration (organization_id IS NULL). Lets
    // the API reject delete attempts cleanly with a 409 rather than
    // requiring callers to know about NULL semantics.
    isBuiltIn: boolean('is_built_in').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-org case-folded name uniqueness. Built-ins (NULL org) are
    // handled by a separate partial index so we don't fight Postgres's
    // NULL-distinct treatment in plain unique constraints.
    orgNameUniq: uniqueIndex('procedure_step_categories_org_name_uniq')
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`organization_id IS NOT NULL`),
    builtInNameUniq: uniqueIndex('procedure_step_categories_builtin_name_uniq')
      .on(sql`lower(${t.name})`)
      .where(sql`organization_id IS NULL`),
    orgIdx: index('procedure_step_categories_org_idx').on(t.organizationId),
  }),
);

export const procedureStepCategoriesRelations = relations(
  procedureStepCategories,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [procedureStepCategories.organizationId],
      references: [organizations.id],
    }),
    createdBy: one(users, {
      fields: [procedureStepCategories.createdByUserId],
      references: [users.id],
    }),
  }),
);

export type ProcedureStepCategory = typeof procedureStepCategories.$inferSelect;
export type NewProcedureStepCategory = typeof procedureStepCategories.$inferInsert;
