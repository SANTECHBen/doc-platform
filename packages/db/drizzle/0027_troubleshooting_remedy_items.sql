-- Structured cause + remedy items on troubleshooting rows. Each item is
-- a discrete entry with its own optional Job Aid link, so the tech can
-- see (and run) each cause/remedy in turn rather than reading a
-- paragraph with one generic "Run procedure" button at the bottom.
--
-- Shape: jsonb array of { text: string, documentId?: string }. Empty
-- array (default) = legacy `cause` / `remedy` text columns still in use.
-- New authoring writes to the structured arrays; PWA renders items as
-- discrete rows with an inline Run button per item.

ALTER TABLE "troubleshooting_items"
  ADD COLUMN IF NOT EXISTS "cause_items" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "troubleshooting_items"
  ADD COLUMN IF NOT EXISTS "remedy_items" jsonb NOT NULL DEFAULT '[]'::jsonb;
