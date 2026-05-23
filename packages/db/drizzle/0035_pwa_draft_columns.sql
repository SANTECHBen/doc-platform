-- PWA-submitted procedure drafts — part 2: columns + partial index that
-- references the 'pending_admin_decision' enum value added in 0034.

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
--> statement-breakpoint
-- Partial index — fast lookup of "what's waiting for me" on the admin
-- list page. Safe to reference the new enum value here because 0034
-- (enum add) committed before this migration ran.
CREATE INDEX IF NOT EXISTS "procedure_draft_runs_pending_review_idx"
  ON "procedure_draft_runs" ("owner_organization_id", "updated_at")
  WHERE "status" = 'pending_admin_decision';
