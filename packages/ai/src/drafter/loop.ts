// Drafter loop — runs Claude Opus 4.7 via AI Gateway with a multimodal
// user message (transcript + storyboard sprite), capturing step proposals
// through the emitDraftStep tool. Terminates when finalizeDraft is called
// or step/time caps are hit.
//
// We use streamText (not generateObject) because the model emits one step
// at a time — gives the reviewer SSE-style progress and is resilient to
// one malformed step (the rest still land).

import { gateway } from '@ai-sdk/gateway';
import { streamText, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import {
  DraftProposalTreeSchema,
  DraftStepProposalSchema,
  type DraftProposalTree,
  type DraftStepProposal,
} from './schema.js';
import {
  VIDEO_DRAFTER_SYSTEM_PROMPT,
  buildDraftUserText,
} from './prompts.js';

export interface DrafterLoopOptions {
  /** Transcript text annotated with [mm:ss] markers. The pipeline assembles
   *  this from the Mux VTT or Whisper segments. */
  transcriptWithTimestamps: string;
  /** Source video duration, used to bound timestamp picks. */
  durationMs: number;
  /** Mux storyboard sprite URL. Pass null when the storyboard isn't
   *  available (fallback to transcript-only segmentation). */
  storyboardImageUrl: string | null;
  proposedTitle: string;
  /** Optional model override. Defaults to anthropic/claude-opus-4.7 routed
   *  through the AI Gateway. */
  model?: LanguageModel | string;
  /** Cap steps the model can take. Default 80 (covers ~50 emitDraftStep
   *  calls + retries + finalize). */
  maxSteps?: number;
  /** Wall-clock cap in ms. Default 300s — generous for a 30 min video. */
  timeoutMs?: number;
  /** Caller's abort signal. Composes with the wall-clock timer. */
  signal?: AbortSignal;
  /** Streaming progress sink — called once per emitDraftStep with the
   *  validated proposal. Lets the API broadcast to SSE listeners without
   *  polling the loop's result. */
  onStepEmitted?: (step: DraftStepProposal) => void;
}

export interface DrafterLoopResult {
  finalized: boolean;
  proposal: DraftProposalTree;
  modelUsed: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  steps: number;
  reason: 'finish' | 'abort' | 'timeout' | 'error';
  error?: string;
}

const DEFAULT_MODEL = 'anthropic/claude-opus-4.7';

export async function runDrafterLoop(
  options: DrafterLoopOptions,
): Promise<DrafterLoopResult> {
  const {
    model = DEFAULT_MODEL,
    maxSteps = 80,
    timeoutMs = 300_000,
    signal: parentSignal,
  } = options;

  // Compose timeout + caller abort onto a single signal.
  const ac = new AbortController();
  const onParentAbort = () => ac.abort(parentSignal?.reason ?? new Error('aborted'));
  if (parentSignal) {
    if (parentSignal.aborted) ac.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => ac.abort(new Error('drafter loop timeout')),
    timeoutMs,
  );

  // Accumulators populated by the tool calls. finalizeDraft uses these
  // to build the persisted DraftProposalTree.
  const proposedSteps: DraftStepProposal[] = [];
  let finalSummary: string | undefined;
  let finalWarnings: string[] = [];
  let finalized = false;

  const tools = {
    emitDraftStep: tool({
      description:
        'Emit one proposed step. Schema-validated; reject + retry on error. Call once per step in transcript order.',
      inputSchema: DraftStepProposalSchema,
      execute: async (input: DraftStepProposal) => {
        // Bound the timestamp against the source duration. Clamp rather
        // than reject so a slightly off pick still lands.
        if (input.keyframeTimestampMs > options.durationMs) {
          input.keyframeTimestampMs = Math.max(0, options.durationMs - 500);
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

  const userText = buildDraftUserText({
    transcriptWithTimestamps: options.transcriptWithTimestamps,
    durationMs: options.durationMs,
    storyboardImageUrl: options.storyboardImageUrl,
    proposedTitle: options.proposedTitle,
  });

  let reason: DrafterLoopResult['reason'] = 'finish';
  let error: string | undefined;
  let usage: DrafterLoopResult['usage'] = null;
  let modelUsed = typeof model === 'string' ? model : 'unknown';
  let actualSteps = 0;

  try {
    const result = streamText({
      model: typeof model === 'string' ? gateway(model) : model,
      system: VIDEO_DRAFTER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            ...(options.storyboardImageUrl
              ? [
                  {
                    type: 'image' as const,
                    image: options.storyboardImageUrl,
                  },
                ]
              : []),
          ],
        },
      ],
      tools,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: ac.signal,
    });

    // Drain. We don't surface text deltas to the caller (the loop emits
    // structured steps, not prose) but we still need to drive the stream
    // to completion so tool calls fire.
    for await (const _chunk of result.textStream) {
      // no-op
    }
    const finalUsage = await result.usage;
    if (finalUsage) {
      usage = {
        inputTokens: Number(finalUsage.inputTokens ?? 0),
        outputTokens: Number(finalUsage.outputTokens ?? 0),
      };
    }
    actualSteps = (await result.steps).length;
    modelUsed = (await result.response).modelId ?? modelUsed;
  } catch (err) {
    if (ac.signal.aborted) {
      reason = ac.signal.reason instanceof Error &&
        ac.signal.reason.message === 'drafter loop timeout'
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
      proposal: { schemaVersion: 1, summary: undefined, warnings: [], steps: [] as never },
      modelUsed,
      usage,
      steps: actualSteps,
      reason,
      error: error ?? 'no steps emitted',
    };
  }

  const validated = DraftProposalTreeSchema.safeParse({
    schemaVersion: 1,
    summary: finalSummary,
    warnings: finalWarnings,
    steps: proposedSteps,
  });
  if (!validated.success) {
    return {
      finalized,
      proposal: {
        schemaVersion: 1,
        summary: finalSummary,
        warnings: finalWarnings,
        steps: proposedSteps as DraftStepProposal[],
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
