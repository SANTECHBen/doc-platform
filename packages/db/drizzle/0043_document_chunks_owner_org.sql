-- Add denormalized owner_organization_id to document_chunks as defense-in-
-- depth against cross-tenant RAG leakage.
--
-- Before this change, the chat retriever WHEREd only on
-- content_pack_version_id. A single CTE bug or a pinned-version misassignment
-- would silently leak chunks across tenants. With this column, the retriever
-- also filters on owner_organization_id so the leak requires *both* the
-- version id AND the org id to be wrong — much smaller failure surface. See
-- H-AI-2 in the security audit (May 2026).
--
-- Backfill strategy:
--   1. Add column nullable.
--   2. Backfill from documents.content_pack_version → pack → owner.
--   3. Set NOT NULL once backfill completes.

ALTER TABLE "document_chunks"
  ADD COLUMN IF NOT EXISTS "owner_organization_id" uuid
  REFERENCES "organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint

UPDATE "document_chunks" c
SET "owner_organization_id" = p."owner_organization_id"
FROM "content_pack_versions" v
JOIN "content_packs" p ON p."id" = v."content_pack_id"
WHERE c."content_pack_version_id" = v."id"
  AND c."owner_organization_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "document_chunks"
  ALTER COLUMN "owner_organization_id" SET NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_chunks_owner_org_idx"
  ON "document_chunks" ("owner_organization_id");
