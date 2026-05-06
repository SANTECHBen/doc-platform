CREATE TYPE "public"."procedure_run_status" AS ENUM('in_progress', 'paused', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."procedure_step_kind" AS ENUM('instruction', 'safety_check', 'photo_required', 'measurement_required');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "part_procedure_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"procedure_step_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_procedure_steps_uniq" UNIQUE("part_id","procedure_step_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procedure_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid,
	"user_id" uuid NOT NULL,
	"asset_instance_id" uuid,
	"work_order_id" uuid,
	"status" "procedure_run_status" DEFAULT 'in_progress' NOT NULL,
	"abandoned_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_active_ms" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procedure_step_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"skip_reason" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"numeric_value" double precision,
	"pass_fail_value" text,
	"text_value" text,
	"measurement_out_of_spec" boolean DEFAULT false NOT NULL,
	"measurement_override_reason" text,
	"notes" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"time_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procedure_step_completions_run_step_uniq" UNIQUE("run_id","step_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procedure_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "procedure_step_kind" DEFAULT 'instruction' NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text,
	"safety_critical" boolean DEFAULT false NOT NULL,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"requires_photo" boolean DEFAULT false NOT NULL,
	"min_photo_count" integer DEFAULT 0 NOT NULL,
	"measurement_spec" jsonb,
	"proposed_by_agent_run_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- document_sections start_y / end_y were added in a prior un-journaled
-- migration (0013_section_y_anchors.sql, file present but never tracked
-- in _journal.json). The ADD-COLUMN statements below are idempotent so
-- this migration applies cleanly whether the columns are already there
-- (production, post-section-y-anchors) or not (fresh dev environments).
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "start_y" double precision;--> statement-breakpoint
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "end_y" double precision;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_procedure_steps" ADD CONSTRAINT "part_procedure_steps_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_procedure_steps" ADD CONSTRAINT "part_procedure_steps_procedure_step_id_procedure_steps_id_fk" FOREIGN KEY ("procedure_step_id") REFERENCES "public"."procedure_steps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_procedure_steps" ADD CONSTRAINT "part_procedure_steps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_runs" ADD CONSTRAINT "procedure_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_runs" ADD CONSTRAINT "procedure_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_runs" ADD CONSTRAINT "procedure_runs_asset_instance_id_asset_instances_id_fk" FOREIGN KEY ("asset_instance_id") REFERENCES "public"."asset_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_runs" ADD CONSTRAINT "procedure_runs_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_step_completions" ADD CONSTRAINT "procedure_step_completions_run_id_procedure_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."procedure_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_step_completions" ADD CONSTRAINT "procedure_step_completions_step_id_procedure_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."procedure_steps"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_proposed_by_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("proposed_by_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_procedure_steps_part_idx" ON "part_procedure_steps" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_procedure_steps_step_idx" ON "part_procedure_steps" USING btree ("procedure_step_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_runs_user_idx" ON "procedure_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_runs_document_idx" ON "procedure_runs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_runs_asset_idx" ON "procedure_runs" USING btree ("asset_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procedure_runs_active_uniq" ON "procedure_runs" USING btree ("user_id","document_id","asset_instance_id") WHERE status IN ('in_progress', 'paused');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_step_completions_run_idx" ON "procedure_step_completions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_document_idx" ON "procedure_steps" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_document_order_idx" ON "procedure_steps" USING btree ("document_id","ordering_hint");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- CHECK constraints — hand-augmented post-generate.
-- Drizzle-kit doesn't synthesize these from the schema today; they enforce
-- coherence between the kind discriminator and the typed-evidence columns.
-- ---------------------------------------------------------------------------

-- procedure_steps: a measurement_required step must declare its spec; a
-- photo_required step must mark requires_photo and demand at least 1 photo.
ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_measurement_coherent_chk" CHECK (
  ("kind" = 'measurement_required') = ("measurement_spec" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_photo_coherent_chk" CHECK (
  ("kind" <> 'photo_required') OR ("requires_photo" = true AND "min_photo_count" >= 1)
);--> statement-breakpoint

-- procedure_step_completions: outcome is a small enum (text + CHECK rather
-- than pgEnum so adding a third value later doesn't require a migration);
-- a skipped completion must include a reason.
ALTER TABLE "procedure_step_completions" ADD CONSTRAINT "procedure_step_completions_outcome_chk" CHECK (
  "outcome" IN ('completed', 'skipped')
);--> statement-breakpoint
ALTER TABLE "procedure_step_completions" ADD CONSTRAINT "procedure_step_completions_skip_reason_chk" CHECK (
  ("outcome" = 'skipped') = ("skip_reason" IS NOT NULL)
);