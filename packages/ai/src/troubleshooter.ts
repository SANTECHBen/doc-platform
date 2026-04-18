import type Anthropic from '@anthropic-ai/sdk';
import type { Retriever } from './retrieval';
import type { SafetyFlaggedChunk } from './guardrails';
import { buildSafetyDirective } from './guardrails';
import { buildSystemPrompt, type GroundingContext } from './prompts';

export interface TroubleshooterInput {
  userMessage: string;
  // Prior turns — the system prompt (with grounding) is cached and stable, but
  // user/assistant turns accumulate here.
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  grounding: Omit<GroundingContext, 'chunks'> & {
    // The API layer is responsible for hydrating the safety_critical flag on each
    // chunk by joining to documents.safety_critical at retrieval time.
    chunks: SafetyFlaggedChunk[];
  };
}

export interface TroubleshooterOutput {
  text: string;
  referencedChunkIds: string[];
  usage: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
  };
}

/**
 * Non-streaming troubleshooter call. A streaming variant lives in the API layer
 * so it can forward chunks over SSE without buffering in this package.
 *
 * The system prompt is sent with a `cache_control: ephemeral` marker so the
 * grounding context (the bulk of tokens) is a cache-hit after turn 1.
 */
export async function runTroubleshooter(
  anthropic: Anthropic,
  model: string,
  input: TroubleshooterInput,
): Promise<TroubleshooterOutput> {
  const safetyDirective = buildSafetyDirective(input.grounding.chunks);
  const systemText = buildSystemPrompt(input.grounding, safetyDirective);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: systemText,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: input.userMessage },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const referencedChunkIds = extractCitedChunkIds(text);

  return {
    text,
    referencedChunkIds,
    usage: {
      inputTokens: response.usage.input_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? undefined,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// Pulls chunk IDs from [cite:...] markers the model emits.
export function extractCitedChunkIds(text: string): string[] {
  const ids = new Set<string>();
  const re = /\[cite:([a-f0-9-]{8,})\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * A pluggable retrieve-then-answer pipeline the API layer can call directly.
 */
export async function answerGrounded(params: {
  anthropic: Anthropic;
  model: string;
  retriever: Retriever;
  userMessage: string;
  history: TroubleshooterInput['history'];
  grounding: Omit<TroubleshooterInput['grounding'], 'chunks'>;
  contentPackVersionIds: string[];
  // Takes raw retrieved chunks and decorates them with safety_critical by joining
  // to documents in the API layer. Wiring is done where the DB lives.
  enrichWithSafetyFlags: (chunks: Awaited<ReturnType<Retriever['retrieve']>>) => Promise<
    SafetyFlaggedChunk[]
  >;
  topK?: number;
}): Promise<TroubleshooterOutput> {
  const retrieved = await params.retriever.retrieve({
    query: params.userMessage,
    contentPackVersionIds: params.contentPackVersionIds,
    topK: params.topK ?? 8,
  });
  const chunks = await params.enrichWithSafetyFlags(retrieved);
  return runTroubleshooter(params.anthropic, params.model, {
    userMessage: params.userMessage,
    history: params.history,
    grounding: { ...params.grounding, chunks },
  });
}
