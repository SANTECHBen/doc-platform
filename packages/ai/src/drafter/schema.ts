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

// Bounds for per-step video clip ranges.
//
// STEP_CLIP_MIN_MS is the LLM's target floor — used by the prompt and by
// the loop-time auto-trim that extends short LLM picks. Stays at 2s so
// model emissions read as a real demo, not a glance.
//
// STEP_CLIP_HARD_MIN_MS is the schema's hard floor — the lowest value
// any clip range may take. Lower than STEP_CLIP_MIN_MS so human admins
// can trim shorter than the LLM would ever pick (a 300ms "click here"
// loop is legitimate authoring output even though the LLM shouldn't
// produce it). 200ms is the lowest that reliably renders a recognizable
// frame across our 24–60fps source captures.
export const STEP_CLIP_MIN_MS = 2_000;
export const STEP_CLIP_HARD_MIN_MS = 200;
export const STEP_CLIP_MAX_MS = 20_000;

export const DraftStepProposalSchema = z
  .object({
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
    /** Mux timestamp the executor downloads as a still JPEG. Used as the
     *  poster image for the per-step video clip (shown while HLS loads
     *  and as the offline fallback). Bounded to the source video duration
     *  in the executor. Conventionally picked inside [clipStartMs, clipEndMs]
     *  but the LLM may pick any frame that best represents the action. */
    keyframeTimestampMs: z.number().int().min(0),
    /** Inclusive start of the per-step Mux clip range, in milliseconds.
     *  Aligned to where this step's voiceover speech begins in the
     *  transcript. The runner plays [clipStartMs..clipEndMs] on a loop
     *  on the step card. */
    clipStartMs: z.number().int().min(0),
    /** Exclusive end of the per-step clip range, in milliseconds.
     *  Must satisfy clipEndMs > clipStartMs and the duration must land
     *  in [STEP_CLIP_MIN_MS, STEP_CLIP_MAX_MS]. The executor clamps to
     *  the source video duration and the next step's start. */
    clipEndMs: z.number().int().min(0),
    safetyCritical: z.boolean().default(false),
    /** When kind = 'photo_required', the executor sets requiresPhoto/min_photo_count
     *  to enforce evidence capture. */
    requiresPhoto: z.boolean().default(false),
    minPhotoCount: z.number().int().min(0).max(10).default(0),
    measurementSpec: DraftMeasurementSpecSchema.nullable().optional(),
    /** Short reason the LLM proposed this step — surfaces in the reviewer's
     *  details panel so authors can quickly judge intent. */
    rationale: z.string().max(500).optional(),
  })
  .superRefine((step, ctx) => {
    if (step.clipEndMs <= step.clipStartMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clipEndMs'],
        message: 'clipEndMs must be strictly greater than clipStartMs',
      });
      return;
    }
    const span = step.clipEndMs - step.clipStartMs;
    if (span < STEP_CLIP_HARD_MIN_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clipEndMs'],
        message: `clip duration ${span}ms is below minimum ${STEP_CLIP_HARD_MIN_MS}ms`,
      });
    }
    if (span > STEP_CLIP_MAX_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clipEndMs'],
        message: `clip duration ${span}ms exceeds maximum ${STEP_CLIP_MAX_MS}ms`,
      });
    }
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

// ---------------------------------------------------------------------------
// Document-import drafter (sourceKind 'docx' | 'pdf')
//
// Sibling of the video proposal above. The source is extracted document
// markdown (with [[FIGURE:id]] tokens) instead of a video transcript, so the
// per-step shape drops the three video-clip fields (keyframeTimestampMs,
// clipStartMs, clipEndMs) and adds:
//   - sectionTitle: which procedure section the step belongs to. The document
//     already has explicit sections (e.g. "Removal", "Replacement"); the LLM
//     assigns each step to one and the executor materializes procedure_sections
//     from the distinct titles in first-appearance order.
//   - figureRefs: the figureIds (from the [[FIGURE:id]] tokens / figure list)
//     this step references. The executor wires each into the step's media[]
//     as an image plus a photo_inline block.
//
// The block / measurement / kind vocabularies are shared with the video path
// so the runner and reviewer render both identically.
// ---------------------------------------------------------------------------

export const DraftDocStepProposalSchema = z.object({
  /** Stable per-step id; same role as the video proposal's clientId. */
  clientId: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  kind: DraftStepKindSchema.default('instruction'),
  /** Section this step belongs to. Distinct values become procedure_sections
   *  in first-appearance order. Optional — steps with no section sort above
   *  the first section, mirroring the runtime's orphan-step support. */
  sectionTitle: z.string().min(1).max(200).optional(),
  voiceoverText: z.string().min(1).max(2000),
  blocks: z.array(DraftStepBlockSchema).max(20).default([]),
  /** figureIds this step references, e.g. ["fig-3"]. Validated against the
   *  tree's figures manifest at execute time; unknown ids are dropped. */
  figureRefs: z.array(z.string().min(1).max(80)).max(6).default([]),
  safetyCritical: z.boolean().default(false),
  requiresPhoto: z.boolean().default(false),
  minPhotoCount: z.number().int().min(0).max(10).default(0),
  measurementSpec: DraftMeasurementSpecSchema.nullable().optional(),
  rationale: z.string().max(500).optional(),
});

export type DraftDocStepProposal = z.infer<typeof DraftDocStepProposalSchema>;

/** One figure available to the doc drafter, as persisted in the run's
 *  figures manifest (bytes already uploaded to object storage). Mirrors
 *  @platform/db's DraftFigure but lives here so the ai package has no
 *  circular dependency on the schema row type. */
export const DraftDocFigureSchema = z.object({
  figureId: z.string().min(1).max(80),
  storageKey: z.string().min(1),
  mime: z.string().min(1).max(80),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  caption: z.string().max(500).optional(),
});

export type DraftDocFigure = z.infer<typeof DraftDocFigureSchema>;

export const DraftDocProposalTreeSchema = z.object({
  schemaVersion: z.literal(1),
  /** Discriminates a doc proposal from a video proposal when both are stored
   *  in procedure_draft_proposals.content. Consumers also know the source
   *  from the run row, but this makes the JSON self-describing. */
  source: z.literal('document'),
  summary: z.string().max(2000).optional(),
  warnings: z.array(z.string().max(500)).max(10).default([]),
  /** The figure pool the steps' figureRefs point into. */
  figures: z.array(DraftDocFigureSchema).max(200).default([]),
  steps: z.array(DraftDocStepProposalSchema).min(1).max(80),
});

export type DraftDocProposalTree = z.infer<typeof DraftDocProposalTreeSchema>;
