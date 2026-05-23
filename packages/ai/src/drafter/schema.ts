// Zod schema for the AI video-walkthrough drafter's proposal tree.
//
// The LLM ingests:
//   - the video's transcript with [mm:ss] timestamps,
//   - the Mux storyboard sprite (multi-frame thumbnail image),
//   - a system prompt with SANTECH voice guidelines.
//
// It emits a tree of DraftStepProposal nodes via the emitDraftStep tool,
// then closes the loop with finalizeDraft. The reviewer UI edits this
// tree before the executor materializes procedure_steps rows.

import { z } from 'zod';

// Block content reuses the procedure_steps StepBlock discriminated union.
// Mirror the shape here so the LLM is constrained to the same vocabulary
// the runner can render.

const ParagraphBlock = z.object({
  kind: z.literal('paragraph'),
  text: z.string().max(8000),
});
const CalloutBlock = z.object({
  kind: z.literal('callout'),
  tone: z.enum(['safety', 'warning', 'tip', 'note']),
  title: z.string().max(120).optional(),
  text: z.string().min(1).max(2000),
});
const BulletListBlock = z.object({
  kind: z.literal('bullet_list'),
  items: z.array(z.string().min(1).max(800)).min(1).max(50),
});
const NumberedListBlock = z.object({
  kind: z.literal('numbered_list'),
  items: z.array(z.string().min(1).max(800)).min(1).max(50),
});
const KeyValueBlock = z.object({
  kind: z.literal('key_value'),
  columns: z.tuple([z.string().min(1).max(60), z.string().min(1).max(60)]),
  rows: z
    .array(z.tuple([z.string().min(1).max(200), z.string().min(1).max(200)]))
    .min(1)
    .max(60),
});
export const DraftStepBlockSchema = z.discriminatedUnion('kind', [
  ParagraphBlock,
  CalloutBlock,
  BulletListBlock,
  NumberedListBlock,
  KeyValueBlock,
]);

const NumericSpec = z.object({
  kind: z.literal('numeric'),
  label: z.string().min(1).max(120),
  unit: z.string().min(1).max(40),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  expected: z.number().nullable().optional(),
  tolerancePct: z.number().nullable().optional(),
});
const PassFailSpec = z.object({
  kind: z.literal('pass_fail'),
  label: z.string().min(1).max(120),
  passLabel: z.string().max(40).optional(),
  failLabel: z.string().max(40).optional(),
});
const FreeTextSpec = z.object({
  kind: z.literal('free_text'),
  label: z.string().min(1).max(120),
  placeholder: z.string().max(120).optional(),
  maxLen: z.number().int().min(1).max(2000).optional(),
});
export const DraftMeasurementSpecSchema = z.discriminatedUnion('kind', [
  NumericSpec,
  PassFailSpec,
  FreeTextSpec,
]);

export const DraftStepKindSchema = z.enum([
  'instruction',
  'safety_check',
  'photo_required',
  'measurement_required',
]);

export const DraftStepProposalSchema = z.object({
  /** Stable per-step identifier the LLM picks. Used for execution idempotency
   *  via clientToken = `draft:<proposalId>:step:<clientId>`. Length-bounded
   *  and slugged so an out-of-tree client can't smuggle path characters. */
  clientId: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  /** Model self-rated 0..1 confidence. Surfaces in the reviewer as a chip
   *  so the author can skim low-confidence steps first. */
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  kind: DraftStepKindSchema.default('instruction'),
  /** Cleaned voiceover script. Will be synthesized via OpenAI tts-1-hd at
   *  execute time — not at propose time, because the author may edit. */
  voiceoverText: z.string().min(1).max(2000),
  /** Structured blocks for the on-screen step body. The voiceover is
   *  separate; blocks render even when the audio is muted. */
  blocks: z.array(DraftStepBlockSchema).max(20).default([]),
  /** Mux timestamp the executor downloads as a still frame for media[].
   *  Bounded to the source video duration in the executor. */
  keyframeTimestampMs: z.number().int().min(0),
  safetyCritical: z.boolean().default(false),
  /** When kind = 'photo_required', the executor sets requiresPhoto/min_photo_count
   *  to enforce evidence capture. */
  requiresPhoto: z.boolean().default(false),
  minPhotoCount: z.number().int().min(0).max(10).default(0),
  measurementSpec: DraftMeasurementSpecSchema.nullable().optional(),
  /** Short reason the LLM proposed this step — surfaces in the reviewer's
   *  details panel so authors can quickly judge intent. */
  rationale: z.string().max(500).optional(),
});

export type DraftStepProposal = z.infer<typeof DraftStepProposalSchema>;

export const DraftProposalTreeSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().max(2000).optional(),
  /** Free-form notes from the LLM (low-confidence segments, ambiguous
   *  transcript spans). Renders as a strip at the top of the reviewer. */
  warnings: z.array(z.string().max(500)).max(10).default([]),
  steps: z.array(DraftStepProposalSchema).min(1).max(50),
});

export type DraftProposalTree = z.infer<typeof DraftProposalTreeSchema>;

/**
 * Build the stable client token for an execution-step ledger row. Used in
 * both the runtime executor and the reviewer's "regenerate this step"
 * affordance so identical proposalId+clientId pairs always dedup.
 */
export function buildDraftClientToken(
  proposalId: string,
  clientId: string,
): string {
  return `draft:${proposalId}:step:${clientId}`;
}
