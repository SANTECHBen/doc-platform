-- Unified search index for the voice-search feature.
--
-- Holds one row per indexed unit (document chunk, procedure step, document
-- section) with denormalized fields for fast scope filtering plus a 1024-dim
-- voyage-3-large embedding for vector search.
--
-- Lifecycle:
--   - Document chunks: written by the pipeline at extraction/publish time
--     in parallel to document_chunks (transitional duplication; chat still
--     reads document_chunks).
--   - Procedure steps + document sections: lazy re-embed via the
--     search_index_stale_at dirty-bit on each source table. The 60-second
--     sweeper claims stale rows and re-embeds them off the request path.
--
-- IVFFlat / GIN indexes are declared here because Drizzle's column builder
-- doesn't model them.

DO $$ BEGIN
 CREATE TYPE "search_source_type" AS ENUM (
   'doc_chunk', 'procedure_step', 'document_section'
 );
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "search_index_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_pack_version_id" uuid NOT NULL,
  "document_id" uuid,
  "owner_organization_id" uuid NOT NULL,
  "source_type" "search_source_type" NOT NULL,
  "source_id" uuid NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "embedding" vector(1024),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "embedded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_index_items"
   ADD CONSTRAINT "search_index_items_content_pack_version_id_content_pack_versions_id_fk"
   FOREIGN KEY ("content_pack_version_id") REFERENCES "content_pack_versions"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_index_items"
   ADD CONSTRAINT "search_index_items_document_id_documents_id_fk"
   FOREIGN KEY ("document_id") REFERENCES "documents"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "search_index_items"
   ADD CONSTRAINT "search_index_items_owner_organization_id_organizations_id_fk"
   FOREIGN KEY ("owner_organization_id") REFERENCES "organizations"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_index_source_uniq"
  ON "search_index_items" ("content_pack_version_id", "source_type", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_index_pack_type_idx"
  ON "search_index_items" ("content_pack_version_id", "source_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_index_org_idx"
  ON "search_index_items" ("owner_organization_id");
--> statement-breakpoint
-- IVFFlat for vector search. lists=100 is a reasonable starting point for
-- up to ~100k vectors; revisit if the index grows beyond that.
CREATE INDEX IF NOT EXISTS "search_index_embedding_idx"
  ON "search_index_items" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
--> statement-breakpoint
-- GIN for the FTS leg of hybrid retrieval. websearch_to_tsquery uses the
-- same 'english' config; keep them aligned.
CREATE INDEX IF NOT EXISTS "search_index_fts_idx"
  ON "search_index_items"
  USING gin (to_tsvector('english', "content"));
--> statement-breakpoint

-- Dirty-bit columns on the source tables. NULL means "no re-embed needed."
ALTER TABLE "procedure_steps"
  ADD COLUMN IF NOT EXISTS "search_index_stale_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "procedure_sections"
  ADD COLUMN IF NOT EXISTS "search_index_stale_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "document_sections"
  ADD COLUMN IF NOT EXISTS "search_index_stale_at" timestamptz;
