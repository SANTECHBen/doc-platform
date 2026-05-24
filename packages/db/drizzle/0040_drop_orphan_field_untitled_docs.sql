-- Clean up orphan "Untitled procedure" documents in field_captures packs.
--
-- Origin of the junk
-- ------------------
-- ProcedureDocWizard (PWA manual authoring) calls startFieldProcedure on
-- mount, which inserts a structured_procedure document with the literal
-- title "Untitled procedure" before the tech has typed anything. If the
-- tech then cancels (or the device dies), the procedure_run is marked
-- abandoned but the empty document survives — it shows up in the
-- Maintenance / Library lists with no steps, opening to nothing when
-- tapped.
--
-- Targeting criteria (every condition must hold)
-- ----------------------------------------------
--   1. kind = 'structured_procedure'         — only field-procedures, no
--                                              PDFs / videos / others.
--   2. title = 'Untitled procedure'          — the literal placeholder.
--                                              Real procedures will have
--                                              been renamed by the tech.
--   3. pack.kind = 'field_captures'          — never touch OEM/dealer
--                                              packs. The placeholder
--                                              title shouldn't appear
--                                              there anyway, but we
--                                              double-guard.
--   4. zero procedure_steps                  — only delete docs that
--                                              have NO captured work.
--   5. no procedure_runs in (in_progress,
--      paused)                               — never pull the rug on a
--                                              tech still authoring.
--
-- FK cascades that fire on delete
-- -------------------------------
--   procedure_runs.documentId               — ON DELETE SET NULL. The
--     abandoned run row survives for the audit trail with a null doc
--     pointer.
--   procedure_sections.documentId           — CASCADE. (Untitled docs
--     don't have sections in practice, but the schema cascade is fine.)
--   document_sections.documentId            — CASCADE. Same note.
--
-- Idempotent — running this migration twice deletes nothing the second
-- time around because the predicate yields an empty set after the
-- first pass.

DELETE FROM documents d
USING content_pack_versions v, content_packs p
WHERE d.content_pack_version_id = v.id
  AND v.content_pack_id = p.id
  AND d.kind = 'structured_procedure'
  AND d.title = 'Untitled procedure'
  AND p.kind = 'field_captures'
  AND NOT EXISTS (
    SELECT 1 FROM procedure_steps ps WHERE ps.document_id = d.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM procedure_runs r
    WHERE r.document_id = d.id
      AND r.status IN ('in_progress', 'paused')
  );
