CREATE TYPE "public"."procedure_draft_category" AS ENUM('preventive_maintenance', 'removal_replacement', 'troubleshooting', 'walkthrough');--> statement-breakpoint
ALTER TABLE "procedure_draft_runs" ADD COLUMN "source_video_aspect_ratio" text;--> statement-breakpoint
ALTER TABLE "procedure_draft_runs" ADD COLUMN "source_video_orientation" text;--> statement-breakpoint
ALTER TABLE "procedure_draft_runs" ADD COLUMN "procedure_category" "procedure_draft_category";