-- Sub-page Y anchors for page_range sections. Lets admins crop the rendered
-- PDF to just the part of the start/end pages that contains the procedure
-- (e.g., when a procedure ends mid-page and the next one starts on the
-- same page). Both fields are 0..1 fractional; null means "no crop".
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "start_y" double precision;
ALTER TABLE "document_sections" ADD COLUMN IF NOT EXISTS "end_y" double precision;

-- Drop the existing kind/anchor CHECK constraint and recreate it allowing
-- start_y/end_y on page_range only, with valid 0..1 ranges and start_y < end_y
-- (only meaningful when both are set, which is the common case). For
-- text_range and time_range, both must remain null.
ALTER TABLE "document_sections" DROP CONSTRAINT IF EXISTS "document_sections_kind_anchors_check";

DO $$ BEGIN
 ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_kind_anchors_check" CHECK (
   CASE kind
     WHEN 'page_range' THEN
       page_start IS NOT NULL AND page_end IS NOT NULL AND page_start <= page_end
       AND anchor_excerpt IS NULL AND anchor_context_before IS NULL AND anchor_context_after IS NULL AND text_page_hint IS NULL
       AND time_start_seconds IS NULL AND time_end_seconds IS NULL
       AND (start_y IS NULL OR (start_y >= 0 AND start_y <= 1))
       AND (end_y IS NULL OR (end_y >= 0 AND end_y <= 1))
       AND (start_y IS NULL OR end_y IS NULL OR start_y < end_y OR page_start < page_end)
     WHEN 'text_range' THEN
       anchor_excerpt IS NOT NULL
       AND page_start IS NULL AND page_end IS NULL
       AND time_start_seconds IS NULL AND time_end_seconds IS NULL
       AND start_y IS NULL AND end_y IS NULL
     WHEN 'time_range' THEN
       time_start_seconds IS NOT NULL AND time_end_seconds IS NOT NULL AND time_start_seconds < time_end_seconds
       AND page_start IS NULL AND page_end IS NULL AND text_page_hint IS NULL
       AND anchor_excerpt IS NULL AND anchor_context_before IS NULL AND anchor_context_after IS NULL
       AND start_y IS NULL AND end_y IS NULL
   END
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
