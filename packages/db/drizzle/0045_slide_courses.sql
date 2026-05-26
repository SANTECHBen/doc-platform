-- Slide-course tables.
--
-- A slide course is the authored eLearning experience produced from a PPTX
-- upload. The conversion worker (packages/api/src/worker.ts → pptx-render.ts)
-- writes slide_decks + slide_deck_slides rows after rendering PNGs. Admins
-- edit interactions/voiceover; learners attempt via the PWA player. Per-
-- attempt scoring lives in slide_attempts + slide_attempt_answers; the
-- aggregate folds into activity_results so existing enrollment plumbing in
-- packages/api/src/routes/training.ts is reused unchanged.

-- 1. New enum types ---------------------------------------------------------

CREATE TYPE "slide_deck_conversion_status" AS ENUM (
  'pending',
  'processing',
  'ready',
  'failed'
);
--> statement-breakpoint
CREATE TYPE "slide_navigation_gate" AS ENUM (
  'free',
  'require_voiceover',
  'require_interactions',
  'require_both'
);
--> statement-breakpoint
CREATE TYPE "slide_interaction_kind" AS ENUM (
  'mcq',
  'true_false',
  'drag_match',
  'short_answer_ai'
);
--> statement-breakpoint
CREATE TYPE "slide_attempt_status" AS ENUM (
  'in_progress',
  'submitted',
  'passed',
  'failed'
);
--> statement-breakpoint

-- 2. Extend activity_kind with slide_course ---------------------------------
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction in Postgres < 12;
-- drizzle-orm/postgres-js wraps each --> statement-breakpoint block in its
-- own transaction, so putting this on its own line keeps it safe.

ALTER TYPE "activity_kind" ADD VALUE IF NOT EXISTS 'slide_course';
--> statement-breakpoint

-- 3. slide_decks ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "slide_decks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "conversion_status" "slide_deck_conversion_status" NOT NULL DEFAULT 'pending',
  "conversion_error" text,
  "conversion_started_at" timestamp with time zone,
  "conversion_completed_at" timestamp with time zone,
  "slide_count" integer NOT NULL DEFAULT 0,
  "pass_threshold" real NOT NULL DEFAULT 0.8,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "slide_decks_document_id_key" UNIQUE ("document_id")
);
--> statement-breakpoint

-- 4. slide_deck_slides ------------------------------------------------------

CREATE TABLE IF NOT EXISTS "slide_deck_slides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slide_deck_id" uuid NOT NULL REFERENCES "slide_decks"("id") ON DELETE CASCADE,
  "slide_index" integer NOT NULL,
  "ordering_hint" real NOT NULL DEFAULT 0,
  "title" text,
  "speaker_notes_markdown" text,
  "script_markdown" text,
  "image_storage_key" text,
  "image_width" integer,
  "image_height" integer,
  "voiceover_storage_key" text,
  "voiceover_duration_sec" real,
  "navigation_gate" "slide_navigation_gate" NOT NULL DEFAULT 'free',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "slide_deck_slides_deck_index_key" UNIQUE ("slide_deck_id", "slide_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slide_deck_slides_deck_order_idx"
  ON "slide_deck_slides" ("slide_deck_id", "ordering_hint");
--> statement-breakpoint

-- 5. slide_interactions -----------------------------------------------------

CREATE TABLE IF NOT EXISTS "slide_interactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slide_id" uuid NOT NULL REFERENCES "slide_deck_slides"("id") ON DELETE CASCADE,
  "kind" "slide_interaction_kind" NOT NULL,
  "prompt" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "weight" real NOT NULL DEFAULT 1,
  "ordering_hint" real NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slide_interactions_slide_order_idx"
  ON "slide_interactions" ("slide_id", "ordering_hint");
--> statement-breakpoint

-- 6. slide_attempts ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS "slide_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enrollment_id" uuid NOT NULL REFERENCES "enrollments"("id") ON DELETE CASCADE,
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "current_slide_index" integer NOT NULL DEFAULT 0,
  "status" "slide_attempt_status" NOT NULL DEFAULT 'in_progress',
  "total_score" real,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_activity_at" timestamp with time zone NOT NULL DEFAULT now(),
  "submitted_at" timestamp with time zone,
  CONSTRAINT "slide_attempts_enrollment_activity_key"
    UNIQUE ("enrollment_id", "activity_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slide_attempts_enrollment_idx"
  ON "slide_attempts" ("enrollment_id");
--> statement-breakpoint

-- 7. slide_attempt_answers --------------------------------------------------

CREATE TABLE IF NOT EXISTS "slide_attempt_answers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slide_attempt_id" uuid NOT NULL REFERENCES "slide_attempts"("id") ON DELETE CASCADE,
  "interaction_id" uuid NOT NULL REFERENCES "slide_interactions"("id") ON DELETE CASCADE,
  "answer" jsonb NOT NULL,
  "is_correct" boolean,
  "score" real,
  "ai_grade_rationale" text,
  "answered_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "slide_attempt_answers_attempt_interaction_key"
    UNIQUE ("slide_attempt_id", "interaction_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slide_attempt_answers_attempt_idx"
  ON "slide_attempt_answers" ("slide_attempt_id");
