-- Paired cause/remedy entries on troubleshooting rows. Each item in the
-- jsonb array carries one cause, its specific remedy, and an optional
-- procedure link — matching the OEM mental model where a single symptom
-- has multiple distinct causes, each with its own fix.
--
-- Replaces the cause_items + remedy_items split from 0027 (which
-- treated them as unrelated parallel lists, missing the pairing). Old
-- columns stay on the table as deprecated dead weight — no destructive
-- drop — but the admin UI + PWA only read/write `causes`.
--
-- Shape: jsonb array of { cause: string, remedy: string, documentId?: string }.

ALTER TABLE "troubleshooting_items"
  ADD COLUMN IF NOT EXISTS "causes" jsonb NOT NULL DEFAULT '[]'::jsonb;
