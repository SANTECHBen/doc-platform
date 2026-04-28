// Agent loop — wires the AI Gateway, system prompt, and tools into a single
// streaming run. Returns a Promise that resolves once the LLM stops or
// `finalizeProposal` is called.
//
// Caller is responsible for:
//   - constructing the AgentToolContext (DB, storage, gateway, sinks),
//   - invoking parseConvention beforehand and persisting the scaffold,
//   - listening for events via ctx.emitEvent (typically wired to SSE),
//   - timing out / aborting via ctx.signal.
//
// We use streamText (not streamObject) because the proposal is built
// incrementally via emitProposalNode tool calls — gives sub-second per-node
// updates and is resilient to one malformed branch.

import { gateway } from '@ai-sdk/gateway';
import { streamText, stepCountIs, type LanguageModel } from 'ai';
import { AGENT_SYSTEM_PROMPT, buildAgentUserMessage } from './prompts.js';
import { buildAgentTools, type AgentToolContext } from './tools/index.js';
import type { Manifest, ScaffoldTree, ProposalNode } from './schema.js';

export interface AgentLoopOptions {
  ctx: AgentToolContext;
  manifest: Manifest;
  scaffold: ScaffoldTree;
  /**
   * Existing entities the agent should consider for dedup. Surfaces in the
   * prompt as a static block — the agent can also call searchOrganizations
   * etc. for finer-grained queries.
   */
  existingEntities: {
    organizations: Array<{
      id: string;
      name: string;
      type: string;
      oemCode: string | null;
    }>;
  };
  /**
   * Override the default model. Defaults to 'anthropic/claude-sonnet-4-7'
   * routed through the AI Gateway. Tests pass a mock LanguageModel here.
   */
  model?: LanguageModel | string;
  /**
   * Maximum LLM steps (tool calls + final assistant message). Default 80 —
   * enough for ~50 file extractions plus emissions on a large folder.
   */
  maxSteps?: number;
  /**
   * Wall-clock cap in milliseconds. Aborts the loop if exceeded. Default 600s.
   * Sized for folders with up to ~30 images (vision is the slow path; each
   * classify call is 5-10s wall-clock with Sonnet). Bigger folders should
   * override.
   */
  timeoutMs?: number;
}

export interface AgentLoopResult {
  /** Number of LLM steps actually consumed. */
  steps: number;
  /** Total token usage reported by the gateway, if available. */
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  /** Model id actually used (post-gateway resolution). */
  modelUsed: string;
  /**
   * True if the agent called `finalizeProposal`. False = loop exited from
   * step cap or timeout. Caller can decide how to surface this.
   */
  finalized: boolean;
  /** Reason the loop ended ('finish', 'abort', 'error'). */
  reason: 'finish' | 'abort' | 'error';
  error?: string;
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-7';

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    ctx,
    manifest,
    scaffold,
    existingEntities,
    model = DEFAULT_MODEL,
    maxSteps = 80,
    timeoutMs = 600_000,
  } = options;

  // Compose a wall-clock abort signal on top of the caller's signal.
  const ac = new AbortController();
  const onParentAbort = () => ac.abort(ctx.signal?.reason);
  if (ctx.signal) {
    if (ctx.signal.aborted) ac.abort(ctx.signal.reason);
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error('agent loop timeout')), timeoutMs);

  const tools = buildAgentTools(ctx);
  const userMessage = buildAgentUserMessage({
    manifestSummary: summarizeManifest(manifest),
    scaffoldSummary: summarizeScaffold(scaffold),
    existingEntitiesSummary: summarizeExistingEntities(existingEntities),
    looseFilesSummary: summarizeLooseFiles(scaffold),
  });

  let finalized = false;
  // Wrap finalize sink so we know if the loop legitimately ended.
  const wrappedCtx: AgentToolContext = {
    ...ctx,
    finalize: async (input) => {
      finalized = true;
      await ctx.finalize(input);
    },
  };
  // Re-bind tools to the wrapped ctx so the wrapped finalize is what runs.
  const wrappedTools = buildAgentTools(wrappedCtx);

  let stepsConsumed = 0;
  let usage: AgentLoopResult['usage'] = null;
  let modelUsed = typeof model === 'string' ? model : 'mock';

  try {
    const stream = streamText({
      model: typeof model === 'string' ? gateway(model) : model,
      system: AGENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: wrappedTools,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: ac.signal,
      onStepFinish: ({ usage: stepUsage }) => {
        stepsConsumed += 1;
        if (stepUsage) {
          usage = {
            inputTokens: (usage?.inputTokens ?? 0) + (stepUsage.inputTokens ?? 0),
            outputTokens: (usage?.outputTokens ?? 0) + (stepUsage.outputTokens ?? 0),
          };
        }
      },
      onError: ({ error }) => {
        ctx.emitEvent({
          type: 'error',
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      },
    });

    // Drain the text stream — we don't surface the prose, but we must consume
    // it so the tool calls actually execute.
    for await (const _chunk of stream.textStream) {
      // Discard. Tool calls happen via the tool's execute fn, not the text.
    }
    await stream.finishReason;

    return {
      steps: stepsConsumed,
      usage,
      modelUsed,
      finalized,
      reason: 'finish',
    };
  } catch (err) {
    const aborted = ac.signal.aborted;
    return {
      steps: stepsConsumed,
      usage,
      modelUsed,
      finalized,
      reason: aborted ? 'abort' : 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onParentAbort);
  }
}

// ---------------------------------------------------------------------------
// Prompt summarizers — keep the user message compact.
// ---------------------------------------------------------------------------

function summarizeManifest(m: Manifest): string {
  const byKind: Record<string, number> = {};
  for (const entry of m.entries) {
    const ext = (entry.relativePath.split('.').pop() ?? '').toLowerCase();
    byKind[ext] = (byKind[ext] ?? 0) + 1;
  }
  const top = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, n]) => `${ext}=${n}`)
    .join(', ');
  return [
    `root: ${m.rootName}`,
    `files: ${m.totalFiles}, total size: ${formatBytes(m.totalBytes)}`,
    `top extensions: ${top}`,
  ].join('\n');
}

function summarizeScaffold(s: ScaffoldTree): string {
  if (s.nodes.length === 0) return '(empty — convention parser found nothing)';
  const byKind = s.nodes.reduce<Record<string, ProposalNode[]>>((acc, n) => {
    acc[n.kind] = acc[n.kind] ?? [];
    acc[n.kind]!.push(n);
    return acc;
  }, {});
  const lines: string[] = [];
  for (const [kind, nodes] of Object.entries(byKind)) {
    lines.push(`- ${kind} (${nodes.length}):`);
    for (const n of nodes.slice(0, 5)) {
      lines.push(`    • ${n.clientId} (${describePayload(n)})`);
    }
    if (nodes.length > 5) lines.push(`    … and ${nodes.length - 5} more`);
  }
  if (s.unmatched.length > 0) {
    lines.push(`unmatched (parser saw, couldn't fit): ${s.unmatched.length}`);
    for (const u of s.unmatched.slice(0, 5)) {
      lines.push(`    • ${u.relativePath}: ${u.reason}`);
    }
  }
  return lines.join('\n');
}

function describePayload(n: ProposalNode): string {
  switch (n.kind) {
    case 'organization':
      return `${n.payload.type} "${n.payload.name}"`;
    case 'asset_model':
      return `${n.payload.modelCode} "${n.payload.displayName}"`;
    case 'part':
      return `${n.payload.oemPartNumber} "${n.payload.displayName}"`;
    case 'document':
      return `${n.payload.kind} "${n.payload.title}"`;
    case 'training_module':
      return `"${n.payload.title}"`;
    case 'asset_instance':
      return `serial ${n.payload.serialNumber}`;
    case 'site':
      return `"${n.payload.name}"`;
    case 'content_pack':
      return `${n.payload.layerType} "${n.payload.name}"`;
    default:
      return n.kind;
  }
}

function summarizeExistingEntities(existing: AgentLoopOptions['existingEntities']): string {
  if (existing.organizations.length === 0) return '(none — net-new tenant import)';
  const lines: string[] = ['organizations matching this manifest by name:'];
  for (const o of existing.organizations.slice(0, 10)) {
    lines.push(`  • ${o.name} (${o.type}, oemCode=${o.oemCode ?? '—'}) id=${o.id}`);
  }
  if (existing.organizations.length > 10) {
    lines.push(`  … and ${existing.organizations.length - 10} more`);
  }
  return lines.join('\n');
}

function summarizeLooseFiles(scaffold: ScaffoldTree): string {
  if (scaffold.looseFiles.length === 0) {
    return '(none — convention parser classified everything)';
  }
  const lines: string[] = [];
  for (const f of scaffold.looseFiles.slice(0, 30)) {
    lines.push(`- ${f.relativePath}`);
  }
  if (scaffold.looseFiles.length > 30) {
    lines.push(`… and ${scaffold.looseFiles.length - 30} more`);
  }
  return lines.join('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
