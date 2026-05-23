-- PWA-submitted procedure drafts — part 2: columns + FK constraints.
--
-- The original v1 of this migration included a partial index
--   CREATE INDEX ... WHERE status = 'pending_admin_decision'
-- but Postgres refuses references to a newly-added enum value within the
-- same transaction the value was added in, and Drizzle's migrator wraps
-- every pending migration set in one transaction. We drop the partial
-- index — the existing org_idx on (owner_organization_id, created_at)
-- covers the "show me pending" admin query fine, and we can revisit the
-- partial index in a follow-up migration after this one commits.

ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "pwa_submitted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "submitted_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "submitted_from_asset_instance_id" uuid;
--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "submission_notes" text;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "procedure_draft_runs"
   ADD CONSTRAINT "procedure_draft_runs_submitted_by_user_id_users_id_fk"
   FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_runs"
   ADD CONSTRAINT "procedure_draft_runs_submitted_from_asset_instance_id_fk"
   FOREIGN KEY ("submitted_from_asset_instance_id") REFERENCES "asset_instances"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
