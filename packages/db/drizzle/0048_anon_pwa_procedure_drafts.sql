-- Anonymous PWA scan-session walkthrough submissions need
-- created_by_user_id to be nullable. After the security pass that
-- stripped identity headers from the PWA → API proxy, the
-- /pwa/procedure-drafts POST has no authenticated user — only a
-- scan-session cookie. The row stores null and renders as "Field
-- tech" in admin review, matching the pattern established for PM
-- service records and work orders (migration 0029).
--
-- Hand-edited: only the ALTERs needed for this change. Drop the
-- existing FK, drop NOT NULL, re-add the FK with ON DELETE SET NULL
-- so a future admin user removal preserves the draft row.

DO $$ BEGIN
  ALTER TABLE "procedure_draft_runs" DROP CONSTRAINT "procedure_draft_runs_created_by_user_id_users_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "procedure_draft_runs" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "procedure_draft_runs" ADD CONSTRAINT "procedure_draft_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
