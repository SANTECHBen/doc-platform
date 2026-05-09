CREATE TABLE IF NOT EXISTS "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asset_instance_id" uuid,
	"qr_code" text,
	"org_id" uuid,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"browser_ua" text,
	"viewport" jsonb,
	"app_version" text,
	"contact_email" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback" ADD CONSTRAINT "feedback_asset_instance_id_asset_instances_id_fk" FOREIGN KEY ("asset_instance_id") REFERENCES "public"."asset_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback" ADD CONSTRAINT "feedback_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_submitted_idx" ON "feedback" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_org_idx" ON "feedback" USING btree ("org_id");