-- procedure_sections: optional grouping above procedure_steps so a single
-- procedure can split into named phases (Removal, Replacement, Verification).
-- Step numbering restarts within each section at render time.
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
DO $$ BEGIN
 ALTER TABLE "procedure_sections" ADD CONSTRAINT "procedure_sections_document_id_documents_id_fk"
   FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_sections" ADD CONSTRAINT "procedure_sections_created_by_user_id_users_id_fk"
   FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_sections_document_idx" ON "procedure_sections" ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_sections_document_order_idx" ON "procedure_sections" ("document_id","ordering_hint");--> statement-breakpoint

-- Add nullable section_id on procedure_steps. Existing steps stay sectionless
-- (rendered above any explicit sections) until an author moves them. The
-- backfill below creates a default "Steps" section per document with existing
-- steps and reparents them, so the upgrade is a no-op visually.
ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "section_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps" ADD CONSTRAINT "procedure_steps_section_id_procedure_sections_id_fk"
   FOREIGN KEY ("section_id") REFERENCES "procedure_sections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_section_order_idx" ON "procedure_steps" ("section_id","ordering_hint");--> statement-breakpoint

-- Backfill: for every document that already has procedure_steps, create one
-- default "Steps" section and move all of that doc's existing steps into it.
-- Idempotent — re-running the migration only inserts sections for docs that
-- still have NULL section_id steps (so it skips already-migrated rows).
INSERT INTO "procedure_sections" ("document_id", "title", "ordering_hint")
SELECT DISTINCT "document_id", 'Steps', 0
FROM "procedure_steps"
WHERE "section_id" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "procedure_steps" ps
SET "section_id" = sec.id
FROM "procedure_sections" sec
WHERE ps."section_id" IS NULL
  AND sec."document_id" = ps."document_id"
  AND sec."title" = 'Steps'
  AND sec."ordering_hint" = 0;
