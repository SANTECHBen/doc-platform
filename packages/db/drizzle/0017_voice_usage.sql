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
CREATE INDEX IF NOT EXISTS "voice_usage_org_created_idx" ON "voice_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_usage_kind_idx" ON "voice_usage" USING btree ("kind");--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "voice_quota" jsonb;
