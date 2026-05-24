-- procedure_step_categories: author-extensible semantic tags applied to
-- procedure_sections (drives the PWA phase-progress strip's color and
-- icon) and individually to procedure_steps (drives an in-body badge on
-- the step card).
--
-- Two-tier ownership:
--   organization_id IS NULL — built-in / platform-wide category, seeded
--     once below. Visible to every org. is_built_in = true.
--   organization_id IS NOT NULL — an org's own custom category. Visible
--     only to that org. is_built_in = false.
--
-- Built-ins seeded by this migration:
--   Safety       — #EAB308 (yellow-500)  icon = shield-alert
--   Verification — #16A34A (green-600)   icon = circle-check
--
-- The PWA renders strip segments and per-step badges using `color`
-- verbatim as a CSS color, and maps `icon` through a Lucide allowlist.
-- The admin "Step categories" manager constrains the color picker to a
-- safe palette while still allowing a custom-hex input.

CREATE TABLE IF NOT EXISTS "procedure_step_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = built-in / platform-wide; non-NULL = per-org category.
  "organization_id" uuid,
  "name" text NOT NULL,
  -- Hex color (e.g. "#EAB308"). API validates the format.
  "color" text NOT NULL,
  -- Lucide icon name; nullable. Renderer falls back to no icon when
  -- the value is not in its allowlist.
  "icon" text,
  -- Lower = renders first in admin pickers.
  "sort_order" integer DEFAULT 0 NOT NULL,
  -- True for the rows seeded below. Lets the API reject delete attempts
  -- with a clean 409 instead of relying on NULL semantics.
  "is_built_in" boolean DEFAULT false NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "procedure_step_categories" ADD CONSTRAINT "procedure_step_categories_organization_id_organizations_id_fk"
   FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "procedure_step_categories" ADD CONSTRAINT "procedure_step_categories_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Case-folded uniqueness, scoped:
--   * Per-org names are unique within that org (and may overlap built-in names).
--   * Built-in names are globally unique (a single set seeded once).
-- Two partial unique indexes avoid Postgres's "NULLs distinct" behavior on
-- a single composite unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_step_categories_org_name_uniq"
  ON "procedure_step_categories" ("organization_id", lower("name"))
  WHERE organization_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_step_categories_builtin_name_uniq"
  ON "procedure_step_categories" (lower("name"))
  WHERE organization_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_step_categories_org_idx"
  ON "procedure_step_categories" ("organization_id");
--> statement-breakpoint

-- Add category_id to procedure_sections + procedure_steps. Nullable on
-- both — pre-existing rows stay uncategorized (neutral strip color, no
-- badge) until an author opts in. ON DELETE SET NULL so deleting a
-- category never orphans or deletes the section/step it tagged.
ALTER TABLE "procedure_sections" ADD COLUMN IF NOT EXISTS "category_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_sections" ADD CONSTRAINT "procedure_sections_category_id_procedure_step_categories_id_fk"
   FOREIGN KEY ("category_id") REFERENCES "procedure_step_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_sections_category_idx"
  ON "procedure_sections" ("category_id");
--> statement-breakpoint

ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "category_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_category_id_procedure_step_categories_id_fk"
   FOREIGN KEY ("category_id") REFERENCES "procedure_step_categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_category_idx"
  ON "procedure_steps" ("category_id");
--> statement-breakpoint

-- Seed built-in categories. Idempotent on (lower(name)) under the
-- builtin partial unique index — re-running the migration is a no-op.
-- Colors chosen to match the PWA's existing signal palette:
--   #EAB308 = yellow-500 (Tailwind)  — used by safety chips elsewhere
--   #16A34A = green-600              — used by signal-ok / completed
INSERT INTO "procedure_step_categories" (
  "organization_id", "name", "color", "icon", "sort_order", "is_built_in"
) VALUES
  (NULL, 'Safety',       '#EAB308', 'shield-alert', 10, true),
  (NULL, 'Verification', '#16A34A', 'circle-check', 20, true)
ON CONFLICT DO NOTHING;
