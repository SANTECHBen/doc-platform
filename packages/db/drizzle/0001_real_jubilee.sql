ALTER TYPE "public"."document_kind" ADD VALUE 'slides';--> statement-breakpoint
ALTER TYPE "public"."document_kind" ADD VALUE 'file';--> statement-breakpoint
ALTER TYPE "public"."document_kind" ADD VALUE 'external_video';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "external_url" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "original_filename" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "size_bytes" integer;