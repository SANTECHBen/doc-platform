-- Anonymous PWA scan-session writes need performed_by_user_id to be
-- nullable. Drop the existing NOT NULL FK, then re-add with
-- ON DELETE SET NULL so future admin user removals preserve the
-- compliance history row rather than purging it.
--
-- This file is hand-edited: drizzle-kit's auto-generated diff
-- included spurious CREATE TYPE / CREATE TABLE statements for
-- already-existing objects (the local schema introspection lagged
-- prod), which crashed migrate-on-boot on `type ... already exists`.
-- We keep only the four real ALTERs below.

DO $$ BEGIN
  ALTER TABLE "pm_service_records" DROP CONSTRAINT "pm_service_records_performed_by_user_id_users_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "pm_service_records" ALTER COLUMN "performed_by_user_id" DROP NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "pm_service_records" ADD CONSTRAINT "pm_service_records_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "pm_plan_service_records" DROP CONSTRAINT "pm_plan_service_records_performed_by_user_id_users_id_fk";
EXCEPTION
  WHEN undefined_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "pm_plan_service_records" ALTER COLUMN "performed_by_user_id" DROP NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "pm_plan_service_records" ADD CONSTRAINT "pm_plan_service_records_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
