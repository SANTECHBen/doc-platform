-- documents.ai_indexed: per-document switch controlling whether the AI
-- chat retriever can quote this document. Lets admins keep noisy or
-- unreviewed sources (e.g., a 135-page arc-flash placard PDF) out of
-- chat answers while leaving them available in the Documents tab.
--
-- Backfill: every existing row defaults to TRUE so behavior doesn't
-- change silently for live conversations. The API layer applies
-- kind-aware defaults on NEW inserts (structured_procedure / markdown
-- start true; pdf / slides / schematic / file / video / external_video
-- start false — the admin opts them in).
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "ai_indexed" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- Index for the retriever's JOIN filter (`WHERE d.ai_indexed = true`).
-- Cheap to maintain; chunks-by-doc retrieval is hot path.
CREATE INDEX IF NOT EXISTS "documents_ai_indexed_idx"
  ON "documents" ("ai_indexed");
