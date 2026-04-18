import { z } from 'zod';

// Activity configs — these live inside the `config` jsonb column and are validated
// at author time and at submission time.

export const QuizConfigSchema = z.object({
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1),
        options: z.array(z.string()).min(2).max(8),
        correctIndex: z.number().int().nonnegative(),
        explanation: z.string().optional(),
      }),
    )
    .min(1),
});

export const ChecklistConfigSchema = z.object({
  items: z
    .array(
      z.object({
        text: z.string().min(1),
        required: z.boolean().default(true),
      }),
    )
    .min(1),
});

export const ProcedureSignoffConfigSchema = z.object({
  steps: z
    .array(
      z.object({
        text: z.string().min(1),
        requiresSignature: z.boolean().default(false),
        hazards: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

export const VideoKnowledgeCheckConfigSchema = z.object({
  videoStreamId: z.string().min(1),
  // Seconds of viewing required before questions unlock.
  gateSeconds: z.number().int().nonnegative().default(0),
  questions: QuizConfigSchema.shape.questions,
});

export const PracticalConfigSchema = z.object({
  rubric: z
    .array(
      z.object({
        criterion: z.string().min(1),
        weight: z.number().positive().default(1),
      }),
    )
    .min(1),
  requiresInstructor: z.boolean().default(true),
});

export const ActivityConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quiz'), config: QuizConfigSchema }),
  z.object({ kind: z.literal('checklist'), config: ChecklistConfigSchema }),
  z.object({ kind: z.literal('procedure_signoff'), config: ProcedureSignoffConfigSchema }),
  z.object({ kind: z.literal('video_knowledge_check'), config: VideoKnowledgeCheckConfigSchema }),
  z.object({ kind: z.literal('practical'), config: PracticalConfigSchema }),
]);
export type ActivityConfig = z.infer<typeof ActivityConfigSchema>;
