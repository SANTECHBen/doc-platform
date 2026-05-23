-- PWA-submitted procedure drafts.
--
-- A tech in the PWA films a walkthrough and submits it. The pipeline still
-- transcribes the video automatically (Mux captions → Whisper fallback)
-- but pauses at pending_admin_decision instead of auto-running the LLM.
-- An admin reviews the transcript and asset context, then explicitly
-- starts the LLM via POST /admin/procedure-drafts/:id/run-ai.
--
-- This puts the cost gate on the admin: PWA submissions never spend a
-- Claude call until someone with budget signs off.

-- Postgres doesn't support adding enum values inside a transaction with
-- other DDL; the alter table that follows lives in the same migration
-- file so drizzle's migrator commits at statement-breakpoints between
-- them.
ALTER TYPE "procedure_draft_run_status" ADD VALUE IF NOT EXISTS 'pending_admin_decision'
  BEFORE 'proposing';
--> statement-breakpoint

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
-- list page.
CREATE INDEX IF NOT EXISTS "procedure_draft_runs_pending_review_idx"
  ON "procedure_draft_runs" ("owner_organization_id", "updated_at")
  WHERE "status" = 'pending_admin_decision';
