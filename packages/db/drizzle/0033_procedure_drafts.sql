-- AI Video-Walkthrough → Procedure Draft.
--
-- procedure_draft_runs is the lifecycle anchor (upload → transcribe → propose
-- → review → execute). The webhook handler discriminates on the Mux upload's
-- passthrough field: "draft:<runId>" routes to the draft pipeline, bare ids
-- route to the onboarding agent.
--
-- procedure_draft_proposals carries the LLM's tree of step proposals
-- (DraftProposalTree schema lives in packages/ai/src/drafter/schema.ts).
-- Optimistic concurrency via `version` so the reviewer can edit safely.
--
-- procedure_draft_executions + procedure_draft_execution_steps are the
-- idempotency ledger — re-execute the same proposal and already-materialized
-- steps surface as 'skipped_existing'.

DO $$ BEGIN
 CREATE TYPE "procedure_draft_run_status" AS ENUM (
   'uploading', 'transcribing', 'storyboarding', 'proposing',
   'awaiting_review', 'executing', 'completed', 'failed', 'cancelled'
 );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "procedure_draft_transcript_source" AS ENUM (
   'mux_captions', 'whisper_fallback', 'manual'
 );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "procedure_draft_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_organization_id" uuid NOT NULL,
  "target_content_pack_version_id" uuid NOT NULL,
  "target_document_id" uuid,
  "proposed_title" text NOT NULL,
  "status" "procedure_draft_run_status" NOT NULL DEFAULT 'uploading',
  "mux_upload_id" text,
  "mux_asset_id" text,
  "mux_playback_id" text,
  "source_video_size_bytes" bigint,
  "source_video_duration_ms" integer,
  "source_transcript" text,
  "source_captions_vtt" text,
  "transcript_source" "procedure_draft_transcript_source",
  "storyboard_vtt_url" text,
  "error" text,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_runs"
   ADD CONSTRAINT "procedure_draft_runs_owner_organization_id_organizations_id_fk"
   FOREIGN KEY ("owner_organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_runs"
   ADD CONSTRAINT "procedure_draft_runs_target_content_pack_version_id_fk"
   FOREIGN KEY ("target_content_pack_version_id") REFERENCES "content_pack_versions"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_runs"
   ADD CONSTRAINT "procedure_draft_runs_target_document_id_documents_id_fk"
   FOREIGN KEY ("target_document_id") REFERENCES "documents"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_runs"
   ADD CONSTRAINT "procedure_draft_runs_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_draft_runs_org_idx"
  ON "procedure_draft_runs" ("owner_organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_draft_runs_mux_upload_idx"
  ON "procedure_draft_runs" ("mux_upload_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_draft_runs_mux_asset_idx"
  ON "procedure_draft_runs" ("mux_asset_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "procedure_draft_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "content" jsonb NOT NULL,
  "summary" text,
  "model_used" text,
  "token_usage" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_proposals"
   ADD CONSTRAINT "procedure_draft_proposals_run_id_procedure_draft_runs_id_fk"
   FOREIGN KEY ("run_id") REFERENCES "procedure_draft_runs"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_draft_proposals_run_uniq"
  ON "procedure_draft_proposals" ("run_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "procedure_draft_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "proposal_id" uuid NOT NULL,
  "proposal_version" integer NOT NULL,
  "started_by_user_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "error" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_executions"
   ADD CONSTRAINT "procedure_draft_executions_proposal_id_fk"
   FOREIGN KEY ("proposal_id") REFERENCES "procedure_draft_proposals"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_executions"
   ADD CONSTRAINT "procedure_draft_executions_started_by_user_id_fk"
   FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_draft_executions_proposal_idx"
  ON "procedure_draft_executions" ("proposal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_draft_executions_status_idx"
  ON "procedure_draft_executions" ("status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "procedure_draft_execution_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "execution_id" uuid NOT NULL,
  "client_token" text NOT NULL,
  "step_type" text NOT NULL,
  "target_procedure_step_id" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "notes" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_draft_execution_steps"
   ADD CONSTRAINT "procedure_draft_execution_steps_execution_id_fk"
   FOREIGN KEY ("execution_id") REFERENCES "procedure_draft_executions"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_draft_execution_steps_exec_token_uniq"
  ON "procedure_draft_execution_steps" ("execution_id", "client_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_draft_execution_steps_exec_status_idx"
  ON "procedure_draft_execution_steps" ("execution_id", "status");
--> statement-breakpoint

ALTER TABLE "procedure_steps"
  ADD COLUMN IF NOT EXISTS "proposed_by_draft_run_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps"
   ADD CONSTRAINT "procedure_steps_proposed_by_draft_run_id_fk"
   FOREIGN KEY ("proposed_by_draft_run_id") REFERENCES "procedure_draft_runs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
