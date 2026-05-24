-- Follow-up to 0040 — also delete orphan "Untitled procedure" field-
-- capture docs whose backing procedure_run is stuck in in_progress /
-- paused because the tech closed the browser tab without explicit
-- cancel. The 0040 migration defensively skipped those because an
-- active run *could* mean "the tech is mid-intake right now"; in
-- practice it almost always means "the tab was closed days ago and
-- nobody updated lastActivityAt since".
--
-- Distinction from 0040 — the run-status guard is now relaxed to
-- "no active run with activity in the last 30 minutes":
--   * A tech currently typing into the wizard (lastActivityAt = now):
--     skipped, safe.
--   * A tech who closed the tab hours/days ago (lastActivityAt stale):
--     deleted.
--
-- Other guards stay strict: title = 'Untitled procedure', zero
-- procedure_steps, only field_captures packs. FK cascades behave the
-- same — procedure_runs.documentId is SET NULL on delete, so any
-- abandoned/stale run rows survive for the audit trail with a null
-- doc pointer.
--
-- Going forward, ProcedureDocWizard defers startFieldProcedure until
-- the tech commits intake (category + title), so we should rarely
-- need another sweep like this.

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
      AND r.last_activity_at > NOW() - INTERVAL '30 minutes'
  );
