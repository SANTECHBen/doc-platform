-- Saved QR designs from the /qr-codes/designer canvas. Holds the full
-- styling spec as opaque JSONB plus org + owner pointers so designs can be
-- listed within the user's scope and edited by their author.
--
-- Visibility:
--   - List/read: any user whose scope contains organization_id (route-level).
--   - Update/delete: owner OR platform admin (route-level).
--
-- The spec column intentionally has no shape constraints — the JSON
-- schema is owned by the designer renderer in the admin app. Postgres
-- TOAST handles compression of any embedded logo data URIs transparently.

CREATE TABLE IF NOT EXISTS "qr_designs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "spec" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_designs_org_updated_idx" ON "qr_designs" ("organization_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_designs_owner_idx" ON "qr_designs" ("owner_user_id");
