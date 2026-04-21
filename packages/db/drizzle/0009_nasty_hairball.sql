CREATE TABLE IF NOT EXISTS "qr_label_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"layout" text DEFAULT 'nameplate' NOT NULL,
	"accent_color" text DEFAULT '#0B5FBF' NOT NULL,
	"logo_storage_key" text,
	"qr_size" integer DEFAULT 92 NOT NULL,
	"qr_error_correction" text DEFAULT 'M' NOT NULL,
	"fields" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qr_label_templates" ADD CONSTRAINT "qr_label_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qr_label_templates" ADD CONSTRAINT "qr_label_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_label_templates_org_idx" ON "qr_label_templates" USING btree ("organization_id");