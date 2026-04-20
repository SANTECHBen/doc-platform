ALTER TABLE "organizations" ADD COLUMN "msft_tenant_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_msft_tenant_id_unique" UNIQUE("msft_tenant_id");