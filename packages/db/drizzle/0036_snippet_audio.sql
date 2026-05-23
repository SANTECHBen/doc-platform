-- Voiceover support on procedure snippets.
--
-- Mirrors the audio columns on procedure_steps so the runner's fallback
-- ("use snippet audio when the attached step has no audio of its own")
-- is a straight column hand-off. audio_source = 'uploaded' | 'generated'
-- matches the procedure_steps convention so audit reports treat both
-- surfaces the same way.

ALTER TABLE "procedure_snippets"
  ADD COLUMN IF NOT EXISTS "audio_storage_key" text;
--> statement-breakpoint
ALTER TABLE "procedure_snippets"
  ADD COLUMN IF NOT EXISTS "audio_content_type" text;
--> statement-breakpoint
ALTER TABLE "procedure_snippets"
  ADD COLUMN IF NOT EXISTS "audio_size_bytes" integer;
--> statement-breakpoint
ALTER TABLE "procedure_snippets"
  ADD COLUMN IF NOT EXISTS "audio_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "procedure_snippets"
  ADD COLUMN IF NOT EXISTS "audio_source" text;
