-- Troubleshooting guides — OEM-style triage tables. Each guide owns
-- many items; each item is a (symptom, cause, remedy) row with an
-- optional procedure link the tech can run from the PWA. Modeled after
-- pm_plans + pm_plan_items so the admin authoring grid + PWA rendering
-- can reuse the same patterns.
--
-- Distinct from pm_schedules (scheduled work) and pm_plans (recurring
-- checklists) — troubleshooting is reactive: tech has a symptom, looks
-- it up, follows the remedy. No service records, no due dates.

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
DO $$ BEGIN
 ALTER TABLE "troubleshooting_guides" ADD CONSTRAINT "troubleshooting_guides_asset_model_id_asset_models_id_fk"
   FOREIGN KEY ("asset_model_id") REFERENCES "asset_models"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_guides" ADD CONSTRAINT "troubleshooting_guides_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "troubleshooting_guides_asset_model_idx" ON "troubleshooting_guides" ("asset_model_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "troubleshooting_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guide_id" uuid NOT NULL,
	"symptom" text NOT NULL,
	"cause" text,
	"remedy" text,
	-- Optional procedure link the tech can run from the PWA when this
	-- symptom matches their problem. set null on delete so removing the
	-- linked procedure clears the link rather than nuking the triage row.
	"document_id" uuid,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_items" ADD CONSTRAINT "troubleshooting_items_guide_id_troubleshooting_guides_id_fk"
   FOREIGN KEY ("guide_id") REFERENCES "troubleshooting_guides"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_items" ADD CONSTRAINT "troubleshooting_items_document_id_documents_id_fk"
   FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "troubleshooting_items" ADD CONSTRAINT "troubleshooting_items_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "troubleshooting_items_guide_idx" ON "troubleshooting_items" ("guide_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "troubleshooting_items_guide_order_idx" ON "troubleshooting_items" ("guide_id","ordering_hint");
