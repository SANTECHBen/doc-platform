-- Document-import source for procedure drafts.
--
-- Adds a second source type to the existing procedure_draft_runs pipeline:
-- alongside the original 'video' (Mux walkthrough) path, drafts can now be
-- seeded from an uploaded Word/PDF procedure document ('docx'|'pdf'). The
-- importer extracts markdown + embedded figures, the admin picks which
-- sections to generate, and the LLM drafter proposes structured steps.
--
-- Two new lifecycle states sit in front of the existing 'proposing' state for
-- the doc path only: 'extracting' (parsing the document) and
-- 'awaiting_section_pick' (waiting on the admin's outline selection). Video
-- drafts never enter either state.
--
-- The new enum values are added but NOT referenced in this migration (no
-- column default, index predicate, or check uses them), so they are safe to
-- add in the same transaction the migrator wraps the pending set in — see the
-- note in 0035_pwa_draft_columns.sql about Postgres refusing to *reference* a
-- freshly-added enum value within its own transaction.

ALTER TYPE "public"."procedure_draft_run_status"
  ADD VALUE IF NOT EXISTS 'extracting' BEFORE 'pending_admin_decision';--> statement-breakpoint
ALTER TYPE "public"."procedure_draft_run_status"
  ADD VALUE IF NOT EXISTS 'awaiting_section_pick' BEFORE 'pending_admin_decision';--> statement-breakpoint

ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'video';--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "source_storage_key" text;--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "source_markdown" text;--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "selected_section_titles" jsonb;--> statement-breakpoint
ALTER TABLE "procedure_draft_runs"
  ADD COLUMN IF NOT EXISTS "figures_manifest" jsonb;
