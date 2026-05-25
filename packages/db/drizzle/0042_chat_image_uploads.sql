-- Track short-lived attribution of chat-image uploads to a specific user/org.
--
-- The /ai/chat endpoint (vision preprocessing) requires that any
-- `imageStorageKey` it accepts correspond to a row in this table owned by the
-- calling user and not yet expired/consumed. Without this gate, any
-- authenticated caller could pass a guessed/leaked storage key belonging to
-- another tenant and have Claude vision return a natural-language description
-- of the bytes — a clean cross-tenant image read. See C-AI-1 in the security
-- audit (May 2026).
--
-- Lifecycle:
--   1. POST /ai/chat-images/upload uploads bytes + inserts a row (1h TTL).
--   2. POST /ai/chat sets consumed_at and proceeds with vision.
--   3. A background sweep deletes consumed/expired rows + their S3 objects.

CREATE TABLE IF NOT EXISTS "chat_image_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "storage_key" text NOT NULL UNIQUE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "content_type" text NOT NULL,
  "size_bytes" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_image_uploads_user_idx" ON "chat_image_uploads" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_image_uploads_org_idx" ON "chat_image_uploads" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_image_uploads_expires_idx" ON "chat_image_uploads" ("expires_at");
