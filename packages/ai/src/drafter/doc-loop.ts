// Document-import drafter loop. Sibling of loop.ts (the video drafter), but
// fed extracted document markdown instead of a video transcript + storyboard.
// No per-step clip ranges, no keyframe/cue snapping — a document has no
// timeline. Emits the same streamed one-step-at-a-time protocol so the
// reviewer gets SSE-style progress and one malformed step doesn't sink the
// rest.

import { gateway } from '@ai-sdk/gateway';
import { streamText, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import {
  DraftDocProposalTreeSchema,
  DraftDocStepProposalSchema,
  type DraftDocFigure,
  type DraftDocProposalTree,
  type DraftDocStepProposal,
} from './schema.js';
import {
  buildDocDrafterSystemPrompt,
  buildDocDraftUserText,
} from './doc-prompts.js';
import type { DrafterCategory } from './prompts.js';

export interface DocDrafterLoopOptions {
  /** Extracted markdown, already sliced to the selected sections, with
   *  [[FIGURE:id]] tokens inline. */
  markdown: string;
  /** Section titles the admin chose to generate. */
  selectedSections: string[];
  /** Figures available to reference (already uploaded; storage keys set). */
  figures: DraftDocFigure[];
  proposedTitle: string;
  procedureCategory?: DrafterCategory | null;
  /** Optional model override. Defaults to anthropic/claude-opus-4.7. */
  model?: LanguageModel | string;
  /** Cap steps the model can take. Default 120 (covers ~80 emit calls +
   *  retries + finalize). */
  maxSteps?: number;
  /** Wall-clock cap in ms. Default 300s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streaming progress sink — called once per emitDraftStep. */
  onStepEmitted?: (step: DraftDocStepProposal) => void;
}

export interface DocDrafterLoopResult {
  finalized: boolean;
  proposal: DraftDocProposalTree;
  modelUsed: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  steps: number;
  reason: 'finish' | 'abort' | 'timeout' | 'error';
  error?: string;
}

const DEFAULT_MODEL = 'anthropic/claude-opus-4.7';

export async function runDocDrafterLoop(
  options: DocDrafterLoopOptions,
): Promise<DocDrafterLoopResult> {
  const {
    model = DEFAULT_MODEL,
    maxSteps = 120,
    timeoutMs = 300_000,
    signal: parentSignal,
  } = options;

  const ac = new AbortController();
  const onParentAbort = () =>
    ac.abort(parentSignal?.reason ?? new Error('aborted'));
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => ac.abort(new Error('doc drafter loop timeout')),
    timeoutMs,
  );

  const proposedSteps: DraftDocStepProposal[] = [];
  let finalSummary: string | undefined;
  let finalWarnings: string[] = [];
  let finalized = false;

  // Valid figure ids the LLM may reference. We drop unknown refs at emit time
  // rather than rejecting the whole step.
  const validFigureIds = new Set(options.figures.map((f) => f.figureId));

  const tools = {
    emitDraftStep: tool({
      description:
        'Emit one proposed step. Schema-validated; reject + retry on error. Call once per step in document order.',
      inputSchema: DraftDocStepProposalSchema,
      execute: async (input: DraftDocStepProposal) => {
        // Drop figure refs that don't exist in the manifest (model
        // hallucination guard) and dedupe.
        if (input.figureRefs.length > 0) {
          input.figureRefs = [...new Set(input.figureRefs)].filter((id) =>
            validFigureIds.has(id),
          );
        }
        proposedSteps.push(input);
        options.onStepEmitted?.(input);
        return { accepted: true, index: proposedSteps.length - 1 };
      },
    }),
    finalizeDraft: tool({
      description:
        'Call exactly once after every step has been emitted. Closes the proposal.',
      inputSchema: z.object({
        summary: z.string().max(2000).optional(),
        warnings: z.array(z.string().max(500)).max(10).default([]),
      }),
      execute: async (input: { summary?: string; warnings: string[] }) => {
        finalSummary = input.summary;
        finalWarnings = input.warnings;
        finalized = true;
        return { accepted: true };
      },
    }),
  } as const;

  const userText = buildDocDraftUserText({
    proposedTitle: options.proposedTitle,
    selectedSections: options.selectedSections,
    markdown: options.markdown,
    figures: options.figures,
  });

  let reason: DocDrafterLoopResult['reason'] = 'finish';
  let error: string | undefined;
  let usage: DocDrafterLoopResult['usage'] = null;
  let modelUsed = typeof model === 'string' ? model : 'unknown';
  let actualSteps = 0;

  try {
    const result = streamText({
      model: typeof model === 'string' ? gateway(model) : model,
      system: buildDocDrafterSystemPrompt(options.procedureCategory ?? null),
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      tools,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: ac.signal,
    });

    for await (const _chunk of result.textStream) {
      // drive the stream so tool calls fire
    }
    const allSteps = await result.steps;
    actualSteps = allSteps.length;
    let summedInput = 0;
    let summedOutput = 0;
    for (const s of allSteps) {
      const u = (s as { usage?: { inputTokens?: number; outputTokens?: number } })
        .usage;
      if (!u) continue;
      summedInput += Number(u.inputTokens ?? 0);
      summedOutput += Number(u.outputTokens ?? 0);
    }
    if (summedInput > 0 || summedOutput > 0) {
      usage = { inputTokens: summedInput, outputTokens: summedOutput };
    } else {
      const finalUsage = await result.usage;
      if (finalUsage) {
        usage = {
          inputTokens: Number(finalUsage.inputTokens ?? 0),
          outputTokens: Number(finalUsage.outputTokens ?? 0),
        };
      }
    }
    modelUsed = (await result.response).modelId ?? modelUsed;
  } catch (err) {
    if (ac.signal.aborted) {
      reason =
        ac.signal.reason instanceof Error &&
        ac.signal.reason.message === 'doc drafter loop timeout'
          ? 'timeout'
          : 'abort';
    } else {
      reason = 'error';
      error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }

  if (proposedSteps.length === 0) {
    return {
      finalized: false,
      proposal: {
        schemaVersion: 1,
        source: 'document',
        summary: undefined,
        warnings: [],
        figures: options.figures,
        steps: [] as never,
      },
      modelUsed,
      usage,
      steps: actualSteps,
      reason,
      error: error ?? 'no steps emitted',
    };
  }

  const validated = DraftDocProposalTreeSchema.safeParse({
    schemaVersion: 1,
    source: 'document',
    summary: finalSummary,
    warnings: finalWarnings,
    figures: options.figures,
    steps: proposedSteps,
  });
  if (!validated.success) {
    return {
      finalized,
      proposal: {
        schemaVersion: 1,
        source: 'document',
        summary: finalSummary,
        warnings: finalWarnings,
        figures: options.figures,
        steps: proposedSteps,
      },
      modelUsed,
      usage,
      steps: actualSteps,
      reason: 'error',
      error: `final proposal validation failed: ${validated.error.message}`,
    };
  }

  return {
    finalized,
    proposal: validated.data,
    modelUsed,
    usage,
    steps: actualSteps,
    reason,
    error,
  };
}
