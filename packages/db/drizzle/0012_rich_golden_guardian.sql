CREATE TYPE "public"."document_section_kind" AS ENUM('page_range', 'text_range', 'time_range');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "document_section_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"page_start" integer,
	"page_end" integer,
	"text_page_hint" integer,
	"anchor_excerpt" text,
	"anchor_context_before" text,
	"anchor_context_after" text,
	"time_start_seconds" double precision,
	"time_end_seconds" double precision,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"safety_critical" boolean DEFAULT false NOT NULL,
	"needs_revalidation" boolean DEFAULT false NOT NULL,
	"revalidation_reason" text,
	"source_extraction_at" timestamp with time zone,
	"proposed_by_agent_run_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "part_document_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"document_section_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "part_document_sections_part_section_uniq" UNIQUE("part_id","document_section_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_proposed_by_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("proposed_by_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_document_sections" ADD CONSTRAINT "part_document_sections_part_id_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_document_sections" ADD CONSTRAINT "part_document_sections_document_section_id_document_sections_id_fk" FOREIGN KEY ("document_section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_document_sections" ADD CONSTRAINT "part_document_sections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sections_document_idx" ON "document_sections" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sections_flag_idx" ON "document_sections" USING btree ("document_id","needs_revalidation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_document_sections_part_idx" ON "part_document_sections" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_document_sections_section_idx" ON "part_document_sections" USING btree ("document_section_id");--> statement-breakpoint
-- Enforce that the right anchor columns are populated per kind. These checks
-- are written by hand because Drizzle doesn't model CHECK constraints.
DO $$ BEGIN
 ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_kind_anchors_check" CHECK (
   CASE kind
     WHEN 'page_range' THEN
       page_start IS NOT NULL AND page_end IS NOT NULL AND page_start <= page_end
       AND anchor_excerpt IS NULL AND anchor_context_before IS NULL AND anchor_context_after IS NULL AND text_page_hint IS NULL
       AND time_start_seconds IS NULL AND time_end_seconds IS NULL
     WHEN 'text_range' THEN
       anchor_excerpt IS NOT NULL
       AND page_start IS NULL AND page_end IS NULL
       AND time_start_seconds IS NULL AND time_end_seconds IS NULL
     WHEN 'time_range' THEN
       time_start_seconds IS NOT NULL AND time_end_seconds IS NOT NULL AND time_start_seconds < time_end_seconds
       AND page_start IS NULL AND page_end IS NULL AND text_page_hint IS NULL
       AND anchor_excerpt IS NULL AND anchor_context_before IS NULL AND anchor_context_after IS NULL
   END
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;