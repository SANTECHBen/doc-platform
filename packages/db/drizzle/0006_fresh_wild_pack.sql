CREATE TABLE IF NOT EXISTS "part_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_part_id" uuid NOT NULL,
	"child_part_id" uuid NOT NULL,
	"position_ref" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_components_parent_part_id_child_part_id_position_ref_unique" UNIQUE("parent_part_id","child_part_id","position_ref")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_components" ADD CONSTRAINT "part_components_parent_part_id_parts_id_fk" FOREIGN KEY ("parent_part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_components" ADD CONSTRAINT "part_components_child_part_id_parts_id_fk" FOREIGN KEY ("child_part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_components_parent_idx" ON "part_components" USING btree ("parent_part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_components_child_idx" ON "part_components" USING btree ("child_part_id");