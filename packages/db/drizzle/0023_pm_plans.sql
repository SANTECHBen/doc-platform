-- PM Plans — the OEM-style checklist (e.g., "ARB Flow Splitter Cleaning &
-- Inspection"). One plan owns many items; each item is a single check
-- (component, what to check, remarks) with its own frequency (D/W/M/Q/S/Y).
-- Tech sees one card per (plan, frequency) in the PWA — "Daily checks (6
-- items)" — and marks the whole batch performed in one tap.
--
-- Distinct from pm_schedules (flat "every N days run procedure X") which
-- stays as-is — the two coexist. pm_plans are for tabulated OEM checklists;
-- pm_schedules are for one-off scheduled procedures.

CREATE TYPE "public"."pm_plan_frequency" AS ENUM ('D','W','M','Q','S','Y');
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
DO $$ BEGIN
 ALTER TABLE "pm_plans" ADD CONSTRAINT "pm_plans_asset_model_id_asset_models_id_fk"
   FOREIGN KEY ("asset_model_id") REFERENCES "asset_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plans" ADD CONSTRAINT "pm_plans_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plans_asset_model_idx" ON "pm_plans" ("asset_model_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pm_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"component" text NOT NULL,
	"check_text" text NOT NULL,
	"remarks" text,
	"frequency" "pm_plan_frequency" NOT NULL,
	-- Optional Job Aid for the item. Tech tapping a row with a document
	-- launches that procedure; rows without document_id are reminder-only.
	"document_id" uuid,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_items" ADD CONSTRAINT "pm_plan_items_plan_id_pm_plans_id_fk"
   FOREIGN KEY ("plan_id") REFERENCES "pm_plans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_items" ADD CONSTRAINT "pm_plan_items_document_id_documents_id_fk"
   FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_items" ADD CONSTRAINT "pm_plan_items_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_items_plan_idx" ON "pm_plan_items" ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_items_plan_order_idx" ON "pm_plan_items" ("plan_id","ordering_hint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_items_plan_frequency_idx" ON "pm_plan_items" ("plan_id","frequency");--> statement-breakpoint

-- Service records — per-(plan, frequency, instance). When a tech taps
-- "Mark Daily checks performed" we insert one row here and the next-due
-- calculation uses MAX(performed_at) per (plan, frequency, instance) as
-- the anchor. The whole frequency-bucket is treated as atomic — v1 doesn't
-- track per-item completion. (Most field checklists are read-and-confirm
-- batches anyway; per-item evidence is a v2 enhancement.)
CREATE TABLE IF NOT EXISTS "pm_plan_service_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_instance_id" uuid NOT NULL,
	"plan_id" uuid,
	"frequency" "pm_plan_frequency" NOT NULL,
	"performed_by_user_id" uuid NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_asset_instance_id_asset_instances_id_fk"
   FOREIGN KEY ("asset_instance_id") REFERENCES "asset_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_plan_id_pm_plans_id_fk"
   FOREIGN KEY ("plan_id") REFERENCES "pm_plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_performed_by_user_id_users_id_fk"
   FOREIGN KEY ("performed_by_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_service_records_instance_plan_freq_idx"
  ON "pm_plan_service_records" ("asset_instance_id","plan_id","frequency","performed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_plan_service_records_instance_performed_idx"
  ON "pm_plan_service_records" ("asset_instance_id","performed_at");
