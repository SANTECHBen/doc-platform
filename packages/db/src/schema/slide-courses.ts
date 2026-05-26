// Slide-course tables.
//
// A slide course is the authored eLearning experience produced from a PPTX
// upload. The pipeline:
//   1. Admin uploads a .pptx → documents row (kind='slides') as today.
//   2. Worker (packages/api/src/worker.ts) extends its extraction loop:
//      after text extraction, shell out to LibreOffice → PDF, then
//      pdftoppm → per-slide PNGs in object storage. Seed slideDecks row
//      + N slideDeckSlides rows.
//   3. Admin opens the course editor (/documents/[id]/course) to edit slide
//      titles, voiceover scripts, upload MP3 voiceover, add interactions,
//      and pick a navigation gate per slide.
//   4. Admin attaches the deck to a training module as an activity with
//      kind='slide_course' and config={ slideDeckId }.
//   5. Learner enrolls in the module and walks the PWA player at
//      /a/[qrCode]/courses/[enrollmentId]. Per-slide answers + progress
//      live in slideAttempts + slideAttemptAnswers. On submit, the
//      aggregate score flows into the existing activityResults table so
//      the enrollment-completion plumbing in packages/api/src/routes/
//      training.ts is reused unchanged.

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  boolean,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { documents } from './content';
import { enrollments, activities } from './training';
import {
  slideDeckConversionStatusEnum,
  slideNavigationGateEnum,
  slideInteractionKindEnum,
  slideAttemptStatusEnum,
} from './enums';

// One row per converted PPTX. 1:1 with a documents row of kind='slides'.
// The conversion lifecycle is tracked here independently of the document's
// extraction status — text extraction can succeed while slide rendering
// fails (or vice-versa) without either blocking the other.
export const slideDecks = pgTable(
  'slide_decks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    conversionStatus: slideDeckConversionStatusEnum('conversion_status')
      .notNull()
      .default('pending'),
    conversionError: text('conversion_error'),
    conversionStartedAt: timestamp('conversion_started_at', { withTimezone: true }),
    conversionCompletedAt: timestamp('conversion_completed_at', { withTimezone: true }),
    slideCount: integer('slide_count').notNull().default(0),
    // Aggregate pass threshold (0..1) used at submit time. Overrides the
    // module-level passThreshold for this activity only.
    passThreshold: real('pass_threshold').notNull().default(0.8),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocument: unique('slide_decks_document_id_key').on(t.documentId),
  }),
);

// One row per slide. slideIndex is the immutable 0-based position from the
// PPTX itself; orderingHint is the mutable author-chosen play order (defaults
// to slideIndex). Re-converting the same PPTX preserves rows keyed by
// slideIndex so interactions/voiceover stick to "slide 3" across re-renders.
export const slideDeckSlides = pgTable(
  'slide_deck_slides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slideDeckId: uuid('slide_deck_id')
      .notNull()
      .references(() => slideDecks.id, { onDelete: 'cascade' }),
    slideIndex: integer('slide_index').notNull(),
    orderingHint: real('ordering_hint').notNull().default(0),
    title: text('title'),
    speakerNotesMarkdown: text('speaker_notes_markdown'),
    scriptMarkdown: text('script_markdown'),
    imageStorageKey: text('image_storage_key'),
    imageWidth: integer('image_width'),
    imageHeight: integer('image_height'),
    voiceoverStorageKey: text('voiceover_storage_key'),
    voiceoverDurationSec: real('voiceover_duration_sec'),
    navigationGate: slideNavigationGateEnum('navigation_gate').notNull().default('free'),
    // Ordered list of content blocks rendered below (or instead of)
    // the slide image. Used for "blank slide" authoring where the
    // admin builds the slide from text/image/video instead of a
    // pre-rendered PNG. Validated server-side by SlideBlockSchema.
    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDeckIndex: unique('slide_deck_slides_deck_index_key').on(t.slideDeckId, t.slideIndex),
    deckOrderIdx: index('slide_deck_slides_deck_order_idx').on(
      t.slideDeckId,
      t.orderingHint,
    ),
  }),
);

// Authored interaction attached to a slide. Config is kind-specific JSON
// validated by SlideInteractionConfigSchema in @platform/shared. Server
// trusts only the stored row when grading; client-supplied correct answers
// are never accepted.
export const slideInteractions = pgTable(
  'slide_interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slideId: uuid('slide_id')
      .notNull()
      .references(() => slideDeckSlides.id, { onDelete: 'cascade' }),
    kind: slideInteractionKindEnum('kind').notNull(),
    prompt: text('prompt').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    weight: real('weight').notNull().default(1),
    orderingHint: real('ordering_hint').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slideOrderIdx: index('slide_interactions_slide_order_idx').on(t.slideId, t.orderingHint),
  }),
);

// One row per learner attempt at one slide-course activity. Persists
// currentSlideIndex so reload-mid-course works; persists totalScore so the
// PWA can show running progress and the server can roll up into
// activityResults on submit.
export const slideAttempts = pgTable(
  'slide_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    currentSlideIndex: integer('current_slide_index').notNull().default(0),
    status: slideAttemptStatusEnum('status').notNull().default('in_progress'),
    totalScore: real('total_score'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => ({
    // One in-progress attempt per learner+activity pair. Submitted attempts
    // are kept for history; resuming starts a fresh in_progress row.
    uniqEnrollmentActivity: unique('slide_attempts_enrollment_activity_key').on(
      t.enrollmentId,
      t.activityId,
    ),
    enrollmentIdx: index('slide_attempts_enrollment_idx').on(t.enrollmentId),
  }),
);

// One row per (attempt, interaction) answer. answer is the raw learner
// submission; isCorrect/score are server-computed. aiGradeRationale is
// populated only for short_answer_ai so authors can audit the LLM's
// judgment later from the admin.
export const slideAttemptAnswers = pgTable(
  'slide_attempt_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slideAttemptId: uuid('slide_attempt_id')
      .notNull()
      .references(() => slideAttempts.id, { onDelete: 'cascade' }),
    interactionId: uuid('interaction_id')
      .notNull()
      .references(() => slideInteractions.id, { onDelete: 'cascade' }),
    answer: jsonb('answer').$type<unknown>().notNull(),
    isCorrect: boolean('is_correct'),
    score: real('score'),
    aiGradeRationale: text('ai_grade_rationale'),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqAttemptInteraction: unique('slide_attempt_answers_attempt_interaction_key').on(
      t.slideAttemptId,
      t.interactionId,
    ),
    attemptIdx: index('slide_attempt_answers_attempt_idx').on(t.slideAttemptId),
  }),
);

// Relations — kept in sync with training.ts conventions.

export const slideDecksRelations = relations(slideDecks, ({ one, many }) => ({
  document: one(documents, {
    fields: [slideDecks.documentId],
    references: [documents.id],
  }),
  slides: many(slideDeckSlides),
}));

export const slideDeckSlidesRelations = relations(slideDeckSlides, ({ one, many }) => ({
  deck: one(slideDecks, {
    fields: [slideDeckSlides.slideDeckId],
    references: [slideDecks.id],
  }),
  interactions: many(slideInteractions),
}));

export const slideInteractionsRelations = relations(slideInteractions, ({ one }) => ({
  slide: one(slideDeckSlides, {
    fields: [slideInteractions.slideId],
    references: [slideDeckSlides.id],
  }),
}));

export const slideAttemptsRelations = relations(slideAttempts, ({ one, many }) => ({
  enrollment: one(enrollments, {
    fields: [slideAttempts.enrollmentId],
    references: [enrollments.id],
  }),
  activity: one(activities, {
    fields: [slideAttempts.activityId],
    references: [activities.id],
  }),
  answers: many(slideAttemptAnswers),
}));

export const slideAttemptAnswersRelations = relations(slideAttemptAnswers, ({ one }) => ({
  attempt: one(slideAttempts, {
    fields: [slideAttemptAnswers.slideAttemptId],
    references: [slideAttempts.id],
  }),
  interaction: one(slideInteractions, {
    fields: [slideAttemptAnswers.interactionId],
    references: [slideInteractions.id],
  }),
}));

export type SlideDeck = typeof slideDecks.$inferSelect;
export type NewSlideDeck = typeof slideDecks.$inferInsert;
export type SlideDeckSlide = typeof slideDeckSlides.$inferSelect;
export type NewSlideDeckSlide = typeof slideDeckSlides.$inferInsert;
export type SlideInteraction = typeof slideInteractions.$inferSelect;
export type NewSlideInteraction = typeof slideInteractions.$inferInsert;
export type SlideAttempt = typeof slideAttempts.$inferSelect;
export type NewSlideAttempt = typeof slideAttempts.$inferInsert;
export type SlideAttemptAnswer = typeof slideAttemptAnswers.$inferSelect;
export type NewSlideAttemptAnswer = typeof slideAttemptAnswers.$inferInsert;
