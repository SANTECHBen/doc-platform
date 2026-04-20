CREATE TYPE "public"."extraction_status" AS ENUM('not_applicable', 'pending', 'processing', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extraction_status" "extraction_status" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_text" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
-- HNSW index for fast cosine-similarity search over voyage-3 embeddings.
-- m=16 / ef_construction=64 are the pgvector defaults that balance build cost
-- vs recall. Revisit if the corpus grows past ~100k chunks.
CREATE INDEX IF NOT EXISTS "document_chunks_embedding_hnsw_idx"
  ON "document_chunks" USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);--> statement-breakpoint
-- GIN index for full-text search. Built from to_tsvector at query time today;
-- precomputing the tsvector here lets Postgres skip the scan on every query.
CREATE INDEX IF NOT EXISTS "document_chunks_content_fts_idx"
  ON "document_chunks" USING gin (to_tsvector('english', content));