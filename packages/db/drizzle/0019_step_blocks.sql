ALTER TABLE "procedure_steps" ADD COLUMN IF NOT EXISTS "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb;
