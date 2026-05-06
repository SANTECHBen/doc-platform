CREATE TYPE "public"."content_pack_kind" AS ENUM('authored', 'field_captures');--> statement-breakpoint
ALTER TABLE "content_packs" ADD COLUMN "kind" "content_pack_kind" DEFAULT 'authored' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "field_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "field_verified_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "scope_asset_instance_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_field_verified_by_user_id_users_id_fk" FOREIGN KEY ("field_verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "documents" ADD CONSTRAINT "documents_scope_asset_instance_id_asset_instances_id_fk" FOREIGN KEY ("scope_asset_instance_id") REFERENCES "public"."asset_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_packs_field_captures_uniq" ON "content_packs" USING btree ("asset_model_id") WHERE kind = 'field_captures';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_scope_instance_idx" ON "documents" USING btree ("scope_asset_instance_id");