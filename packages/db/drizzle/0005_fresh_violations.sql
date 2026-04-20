CREATE TABLE IF NOT EXISTS "part_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_documents_part_id_document_id_unique" UNIQUE("part_id","document_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "part_training_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"training_module_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_training_modules_part_id_training_module_id_unique" UNIQUE("part_id","training_module_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_documents" ADD CONSTRAINT "part_documents_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_documents" ADD CONSTRAINT "part_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_training_modules" ADD CONSTRAINT "part_training_modules_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_training_modules" ADD CONSTRAINT "part_training_modules_training_module_id_training_modules_id_fk" FOREIGN KEY ("training_module_id") REFERENCES "public"."training_modules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_documents_part_idx" ON "part_documents" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_documents_document_idx" ON "part_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_training_modules_part_idx" ON "part_training_modules" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_training_modules_module_idx" ON "part_training_modules" USING btree ("training_module_id");