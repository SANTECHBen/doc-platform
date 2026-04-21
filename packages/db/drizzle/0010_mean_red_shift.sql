ALTER TABLE "qr_codes" ADD COLUMN "preferred_template_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_preferred_template_id_qr_label_templates_id_fk" FOREIGN KEY ("preferred_template_id") REFERENCES "public"."qr_label_templates"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
