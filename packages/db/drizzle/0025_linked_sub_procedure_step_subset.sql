-- Optional step subset for sub-procedure links. When a step's
-- linked_procedure_doc_id is set, the author can also pin which steps
-- from the linked doc to play — useful when the parent only references
-- a few steps from a much larger procedure, so the tech doesn't have to
-- skim through everything to find the relevant ones.
--
-- Empty array = play the full linked procedure (current behavior, no
-- back-compat break). Non-empty = filter the linked doc's steps to
-- just these IDs at render time, preserving the linked doc's natural
-- ordering hint.
ALTER TABLE "procedure_steps"
  ADD COLUMN IF NOT EXISTS "linked_procedure_step_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
