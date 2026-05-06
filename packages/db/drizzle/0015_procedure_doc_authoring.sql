CREATE TABLE IF NOT EXISTS "procedure_substeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procedure_step_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_markdown" text,
	"ordering_hint" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "procedure_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "procedure_steps" ADD COLUMN "media" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_substeps" ADD CONSTRAINT "procedure_substeps_procedure_step_id_procedure_steps_id_fk" FOREIGN KEY ("procedure_step_id") REFERENCES "public"."procedure_steps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "procedure_substeps" ADD CONSTRAINT "procedure_substeps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_substeps_step_idx" ON "procedure_substeps" USING btree ("procedure_step_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "procedure_substeps_step_order_idx" ON "procedure_substeps" USING btree ("procedure_step_id","ordering_hint");