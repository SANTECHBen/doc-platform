CREATE TYPE "public"."pm_cadence_kind" AS ENUM('days');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"asset_instance_id" uuid,
	"kind" text NOT NULL,
	"units" integer NOT NULL,
	"cost_cents" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_model_id" uuid NOT NULL,
	"document_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"cadence_kind" "pm_cadence_kind" DEFAULT 'days' NOT NULL,
	"cadence_value" integer NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_service_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_instance_id" uuid NOT NULL,
	"pm_schedule_id" uuid,
	"document_id" uuid,
	"procedure_run_id" uuid,
	"performed_by_user_id" uuid NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "voice_quota" jsonb;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "blocks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "audio_storage_key" text;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "audio_content_type" text;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "audio_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "audio_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "audio_source" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_usage" ADD CONSTRAINT "voice_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_usage" ADD CONSTRAINT "voice_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_usage" ADD CONSTRAINT "voice_usage_asset_instance_id_asset_instances_id_fk" FOREIGN KEY ("asset_instance_id") REFERENCES "public"."asset_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_asset_model_id_asset_models_id_fk" FOREIGN KEY ("asset_model_id") REFERENCES "public"."asset_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_schedules" ADD CONSTRAINT "pm_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_asset_instance_id_asset_instances_id_fk" FOREIGN KEY ("asset_instance_id") REFERENCES "public"."asset_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_pm_schedule_id_pm_schedules_id_fk" FOREIGN KEY ("pm_schedule_id") REFERENCES "public"."pm_schedules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_procedure_run_id_procedure_runs_id_fk" FOREIGN KEY ("procedure_run_id") REFERENCES "public"."procedure_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_usage_org_created_idx" ON "voice_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_usage_kind_idx" ON "voice_usage" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_schedules_asset_model_idx" ON "pm_schedules" USING btree ("asset_model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_service_records_instance_schedule_idx" ON "pm_service_records" USING btree ("asset_instance_id","pm_schedule_id","performed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_service_records_instance_performed_idx" ON "pm_service_records" USING btree ("asset_instance_id","performed_at");