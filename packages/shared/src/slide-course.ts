import { z } from 'zod';

// Shared validation for slide-course interactions. Both admin (form-level)
// and api (request-body) import these so author input and learner answers
// can never disagree on shape. The discriminator is `kind`; the per-kind
// `config` shape lives inline (rather than reusing QuizConfigSchema) because
// a slide interaction is a *single* question, not a whole quiz.

// -------- MCQ ---------------------------------------------------------------
//
// Multiple choice with one correct option. We keep options as strings (markdown
// allowed, rendered safely by the player). 2..8 options is enough for any
// real-world quiz and matches the existing QuizConfigSchema range.

export const SlideMcqConfigSchema = z.object({
  options: z.array(z.string().min(1).max(500)).min(2).max(8),
  correctIndex: z.number().int().nonnegative(),
  explanation: z.string().max(2000).optional(),
});

// -------- True/false --------------------------------------------------------

export const SlideTrueFalseConfigSchema = z.object({
  correctAnswer: z.boolean(),
  explanation: z.string().max(2000).optional(),
});

// -------- Drag-and-drop matching --------------------------------------------
//
// V1 is text↔text only. The player presents the right-side strings in
// shuffled order and the learner drags them next to the matching left-side
// label. Grading is all-or-nothing per pair; score is correctPairs/totalPairs.

export const SlideDragMatchConfigSchema = z.object({
  pairs: z
    .array(
      z.object({
        left: z.string().min(1).max(200),
        right: z.string().min(1).max(200),
      }),
    )
    .min(2)
    .max(8),
});

// -------- Short answer with AI grading --------------------------------------
//
// The author writes a rubric (plain text or short markdown) describing what
// a correct answer must include. The server hits OpenAI gpt-4o-mini with
// the rubric + the learner's answer + the optional example acceptable
// answers, and gets back a 0..1 score with a rationale. passThreshold is
// the minimum score that counts as "passed" for gating purposes.

export const SlideShortAnswerAiConfigSchema = z.object({
  rubric: z.string().min(10).max(4000),
  exampleAcceptable: z.array(z.string().min(1).max(2000)).max(5).default([]),
  passThreshold: z.number().min(0).max(1).default(0.7),
});

// -------- Discriminated union -----------------------------------------------

export const SlideInteractionConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcq'), config: SlideMcqConfigSchema }),
  z.object({ kind: z.literal('true_false'), config: SlideTrueFalseConfigSchema }),
  z.object({ kind: z.literal('drag_match'), config: SlideDragMatchConfigSchema }),
  z.object({ kind: z.literal('short_answer_ai'), config: SlideShortAnswerAiConfigSchema }),
]);
export type SlideInteractionConfig = z.infer<typeof SlideInteractionConfigSchema>;

// -------- Per-kind learner answer shapes -----------------------------------
//
// Server validates the learner's submission against the matching schema for
// the interaction.kind before grading. Anything else is rejected.

export const SlideMcqAnswerSchema = z.object({
  selectedIndex: z.number().int().nonnegative(),
});
export const SlideTrueFalseAnswerSchema = z.object({
  answer: z.boolean(),
});
export const SlideDragMatchAnswerSchema = z.object({
  // Map left-side label → learner's chosen right-side string.
  mapping: z.record(z.string().min(1), z.string().min(1)),
});
export const SlideShortAnswerAiAnswerSchema = z.object({
  text: z.string().min(1).max(8000),
});

export const SlideInteractionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcq'), answer: SlideMcqAnswerSchema }),
  z.object({ kind: z.literal('true_false'), answer: SlideTrueFalseAnswerSchema }),
  z.object({ kind: z.literal('drag_match'), answer: SlideDragMatchAnswerSchema }),
  z.object({ kind: z.literal('short_answer_ai'), answer: SlideShortAnswerAiAnswerSchema }),
]);
export type SlideInteractionAnswer = z.infer<typeof SlideInteractionAnswerSchema>;

// -------- Navigation gates --------------------------------------------------

export const SlideNavigationGateSchema = z.enum([
  'free',
  'require_voiceover',
  'require_interactions',
  'require_both',
]);
export type SlideNavigationGate = z.infer<typeof SlideNavigationGateSchema>;

export const SLIDE_NAVIGATION_GATE_LABELS: Record<SlideNavigationGate, string> = {
  free: 'Free — learner can advance any time',
  require_voiceover: 'Require voiceover — Next unlocks after audio finishes',
  require_interactions: 'Require interactions — Next unlocks after all are passed',
  require_both: 'Require both — voiceover finished AND interactions passed',
};

export const SLIDE_INTERACTION_KIND_LABELS: Record<SlideInteractionConfig['kind'], string> = {
  mcq: 'Multiple choice',
  true_false: 'True / false',
  drag_match: 'Drag-and-drop match',
  short_answer_ai: 'Short answer (AI graded)',
};

// -------- Slide content blocks ---------------------------------------------
//
// Blank slides are composed of an ordered list of content blocks rather
// than a single pre-rendered image. Each block is a discriminated union
// member; the server validates the whole array before persisting to
// slide_deck_slides.blocks.

export const SlideTextBlockSchema = z.object({
  kind: z.literal('text'),
  markdown: z.string().min(1).max(16000),
});

export const SlideImageBlockSchema = z.object({
  kind: z.literal('image'),
  storageKey: z.string().min(1).max(800),
  url: z.string().url().optional(),
  caption: z.string().max(500).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const SlideVideoUrlBlockSchema = z.object({
  kind: z.literal('video_url'),
  url: z.string().url(),
  caption: z.string().max(500).optional(),
});

export const SlideVideoFileBlockSchema = z.object({
  kind: z.literal('video_file'),
  storageKey: z.string().min(1).max(800),
  url: z.string().url().optional(),
  mimeType: z.string().min(1).max(120),
  caption: z.string().max(500).optional(),
});

export const SlideBlockSchema = z.discriminatedUnion('kind', [
  SlideTextBlockSchema,
  SlideImageBlockSchema,
  SlideVideoUrlBlockSchema,
  SlideVideoFileBlockSchema,
]);
export type SlideBlock = z.infer<typeof SlideBlockSchema>;

export const SlideBlocksSchema = z.array(SlideBlockSchema).max(50);

// -------- Slide-course activity config -------------------------------------
//
// The activities table's jsonb config column stores this shape when
// activities.kind = 'slide_course'.

export const SlideCourseActivityConfigSchema = z.object({
  slideDeckId: z.string().uuid(),
});
export type SlideCourseActivityConfig = z.infer<typeof SlideCourseActivityConfigSchema>;
