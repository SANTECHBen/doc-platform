CREATE TYPE "public"."pm_plan_frequency" AS ENUM('D', 'W', 'M', 'Q', 'S', 'Y');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procedure_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"component" text NOT NULL,
	"check_text" text NOT NULL,
	"remarks" text,
	"frequency" "pm_plan_frequency" NOT NULL,
	"document_id" uuid,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_plan_service_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_instance_id" uuid NOT NULL,
	"plan_id" uuid,
	"frequency" "pm_plan_frequency" NOT NULL,
	"performed_by_user_id" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_model_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "troubleshooting_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_model_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "troubleshooting_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guide_id" uuid NOT NULL,
	"symptom" text NOT NULL,
	"cause" text,
	"remedy" text,
	"cause_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remedy_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"causes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_id" uuid,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pm_service_records" DROP CONSTRAINT "pm_service_records_performed_by_user_id_users_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "pm_service_records" ALTER COLUMN "performed_by_user_id" DROP NOT NULL;--> statement-breakpoint
-- Manual addition: drizzle-kit didn't pick up the equivalent change on
-- pm_plan_service_records because the table also shipped with the same
-- statement-breakpoint contiguous to its CREATE earlier in the file
-- (which is a no-op on prod since the table already exists). Force the
-- ALTERs explicitly so the existing column flips to nullable.
DO $$ BEGIN
  ALTER TABLE "pm_plan_service_records" DROP CONSTRAINT "pm_plan_service_records_performed_by_user_id_users_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "pm_plan_service_records" ALTER COLUMN "performed_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ai_indexed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "linked_procedure_doc_id" uuid;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "linked_procedure_step_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_sections" ADD CONSTRAINT "procedure_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_sections" ADD CONSTRAINT "procedure_sections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_items" ADD CONSTRAINT "pm_plan_items_plan_id_pm_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."pm_plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_items" ADD CONSTRAINT "pm_plan_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_items" ADD CONSTRAINT "pm_plan_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_asset_instance_id_asset_instances_id_fk" FOREIGN KEY ("asset_instance_id") REFERENCES "public"."asset_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_plan_id_pm_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."pm_plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plans" ADD CONSTRAINT "pm_plans_asset_model_id_asset_models_id_fk" FOREIGN KEY ("asset_model_id") REFERENCES "public"."asset_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plans" ADD CONSTRAINT "pm_plans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_guides" ADD CONSTRAINT "troubleshooting_guides_asset_model_id_asset_models_id_fk" FOREIGN KEY ("asset_model_id") REFERENCES "public"."asset_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_guides" ADD CONSTRAINT "troubleshooting_guides_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_items" ADD CONSTRAINT "troubleshooting_items_guide_id_troubleshooting_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."troubleshooting_guides"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_items" ADD CONSTRAINT "troubleshooting_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_items" ADD CONSTRAINT "troubleshooting_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_sections_document_idx" ON "procedure_sections" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_sections_document_order_idx" ON "procedure_sections" USING btree ("document_id","ordering_hint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_items_plan_idx" ON "pm_plan_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_items_plan_order_idx" ON "pm_plan_items" USING btree ("plan_id","ordering_hint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_items_plan_frequency_idx" ON "pm_plan_items" USING btree ("plan_id","frequency");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_service_records_instance_plan_freq_idx" ON "pm_plan_service_records" USING btree ("asset_instance_id","plan_id","frequency","performed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_service_records_instance_performed_idx" ON "pm_plan_service_records" USING btree ("asset_instance_id","performed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plans_asset_model_idx" ON "pm_plans" USING btree ("asset_model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "troubleshooting_guides_asset_model_idx" ON "troubleshooting_guides" USING btree ("asset_model_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "troubleshooting_items_guide_idx" ON "troubleshooting_items" USING btree ("guide_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "troubleshooting_items_guide_order_idx" ON "troubleshooting_items" USING btree ("guide_id","ordering_hint");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_section_id_procedure_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."procedure_sections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_linked_procedure_doc_id_documents_id_fk" FOREIGN KEY ("linked_procedure_doc_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_section_order_idx" ON "procedure_steps" USING btree ("section_id","ordering_hint");