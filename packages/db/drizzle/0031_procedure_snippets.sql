-- Reusable step snippet library.
--
-- Authors define standard content once ("Lockout-Tagout", "Safety Briefing")
-- and reference it from procedure steps. Edits propagate instantly — the
-- read path joins procedure_steps -> procedure_snippets and serves the
-- snippet's current content for any step where snippet_id is set and
-- snippet_detached=false.
--
-- Ownership tiers:
--   is_platform = true  → global (SANTECH-published), owner_organization_id
--                         must be NULL. Writable only by platform admins.
--   is_platform = false → org-scoped, owner_organization_id required.
--
-- Revisions are append-only and exist solely for audit / history-tab UI;
-- the read path never consults them.

CREATE TABLE IF NOT EXISTS "procedure_snippets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_organization_id" uuid,
  "is_platform" boolean NOT NULL DEFAULT false,
  "title" text NOT NULL,
  "kind" "procedure_step_kind" NOT NULL DEFAULT 'instruction',
  "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "procedure_snippets_ownership_check" CHECK (
    (is_platform = true  AND owner_organization_id IS NULL) OR
    (is_platform = false AND owner_organization_id IS NOT NULL)
  )
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_snippets"
   ADD CONSTRAINT "procedure_snippets_owner_organization_id_organizations_id_fk"
   FOREIGN KEY ("owner_organization_id") REFERENCES "organizations"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_snippets"
   ADD CONSTRAINT "procedure_snippets_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_snippets_org_title_uniq"
  ON "procedure_snippets" (
    COALESCE("owner_organization_id"::text, 'PLATFORM'),
    lower("title")
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_snippets_owner_idx"
  ON "procedure_snippets" ("owner_organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_snippets_platform_idx"
  ON "procedure_snippets" ("is_platform") WHERE "is_platform" = true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "procedure_snippet_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snippet_id" uuid NOT NULL,
  "revision_number" integer NOT NULL,
  "title" text NOT NULL,
  "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "change_note" text,
  "created_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_snippet_revisions"
   ADD CONSTRAINT "procedure_snippet_revisions_snippet_id_procedure_snippets_id_fk"
   FOREIGN KEY ("snippet_id") REFERENCES "procedure_snippets"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_snippet_revisions"
   ADD CONSTRAINT "procedure_snippet_revisions_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_snippet_revisions_snippet_rev_uniq"
  ON "procedure_snippet_revisions" ("snippet_id", "revision_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_snippet_revisions_snippet_idx"
  ON "procedure_snippet_revisions" ("snippet_id");
--> statement-breakpoint

ALTER TABLE "procedure_steps"
  ADD COLUMN IF NOT EXISTS "snippet_id" uuid;
--> statement-breakpoint
ALTER TABLE "procedure_steps"
  ADD COLUMN IF NOT EXISTS "snippet_detached" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps"
   ADD CONSTRAINT "procedure_steps_snippet_id_procedure_snippets_id_fk"
   FOREIGN KEY ("snippet_id") REFERENCES "procedure_snippets"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_snippet_idx"
  ON "procedure_steps" ("snippet_id") WHERE "snippet_id" IS NOT NULL;
