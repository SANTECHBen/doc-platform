-- PWA-submitted procedure drafts — part 1: enum value only.
--
-- Postgres won't let a newly-added enum value be referenced in the same
-- transaction it was added in ("unsafe use of new value"). The Drizzle
-- migrator wraps every migration file in a transaction, so the partial
-- index that uses 'pending_admin_decision' is split out into 0035.
-- Keeping this migration tight to the enum addition means it commits
-- cleanly before 0035 runs.

ALTER TYPE "procedure_draft_run_status" ADD VALUE IF NOT EXISTS 'pending_admin_decision'
  BEFORE 'proposing';
