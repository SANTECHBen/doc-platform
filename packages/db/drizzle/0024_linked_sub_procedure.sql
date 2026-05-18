-- Sub-procedure links — a procedure_step can reference another
-- structured_procedure document. When the tech reaches that step in the
-- PWA Job Aid, they get a "Run sub-procedure: <title>" button that
-- pushes the linked procedure as a nested Job Aid (stacked render with
-- breadcrumb). Skipping (just tapping Next) treats the linked sub as
-- optional — useful for "if necessary" branches like:
--   "Replace the belt, if necessary" → links to Belt Replacement
--
-- onDelete: set null so deleting the linked sub-procedure doesn't nuke
-- the parent step — the link just goes away. Validation that the linked
-- doc is the right kind (structured_procedure) lives at the API layer.

ALTER TABLE "procedure_steps"
  ADD COLUMN IF NOT EXISTS "linked_procedure_doc_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_steps"
   ADD CONSTRAINT "procedure_steps_linked_procedure_doc_id_documents_id_fk"
   FOREIGN KEY ("linked_procedure_doc_id") REFERENCES "documents"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_steps_linked_procedure_doc_idx"
  ON "procedure_steps" ("linked_procedure_doc_id");
