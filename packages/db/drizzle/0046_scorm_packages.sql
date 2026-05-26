-- SCORM package support.
--
-- Adds the 'scorm' document kind and 'scorm_course' activity kind, plus
-- the scorm_packages table that holds per-package metadata extracted
-- from imsmanifest.xml on upload. Stored package files live in the
-- existing object-storage abstraction under storage_key_prefix.

ALTER TYPE "document_kind" ADD VALUE IF NOT EXISTS 'scorm';
--> statement-breakpoint

ALTER TYPE "activity_kind" ADD VALUE IF NOT EXISTS 'scorm_course';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scorm_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "storage_key_prefix" text NOT NULL,
  "entry_path" text NOT NULL,
  "scorm_version" text,
  "manifest_title" text,
  "files_index" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "scorm_packages_document_id_key" UNIQUE ("document_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scorm_packages_document_idx"
  ON "scorm_packages" ("document_id");
