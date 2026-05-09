ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "audio_storage_key" text;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "audio_content_type" text;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "audio_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "audio_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "audio_source" text;
