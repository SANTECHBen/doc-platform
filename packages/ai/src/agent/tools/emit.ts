// Emit tools — the agent's only way to add to (or finalize) the proposal.
//
// emitProposalNode validates the node payload against the discriminated union
// before persisting. finalizeProposal terminates the loop. Both are wired up
// to the AgentToolContext sinks, which write to Postgres and broadcast SSE.

import { tool } from 'ai';
import { z } from 'zod';
import { ProposalNodeSchema } from '../schema.js';
import type { AgentToolContext } from './context.js';

// We deliberately don't expose the discriminated union as the inputSchema —
// it's huge and the AI SDK turns Zod schemas into JSON-schema for the model,
// which doesn't compress nicely. Instead the tool's input is loose and we
// validate inside the execute function. This also lets us produce friendlier
// error messages when the LLM fumbles a payload shape.

const EmitInputSchema = z.object({
  node: z
    .unknown()
    .describe(
      'A complete proposal node. Must include: clientId (stable, kebab-case), kind, confidence (0-1), sourceFiles[], rationale, fromConvention=false, payload (kind-specific). Refer to the schema in the system prompt.',
    ),
});

export function emitProposalNodeTool(ctx: AgentToolContext) {
  return tool({
    description:
      "Emit one proposal node into the plan. Call this for every entity you want to add (or amend) — organizations, sites, asset models, parts, BOM entries, content packs, content pack versions, documents, training modules, lessons, asset instances, QR codes, and publish toggles. The node must follow the schema described in the system prompt. clientIds must be unique per run; if you re-emit the same clientId, the later emission overwrites earlier values for that node. Don't re-emit nodes that already came from the convention scaffold.",
    inputSchema: EmitInputSchema,
    execute: async ({ node }) => {
      ctx.emitEvent({ type: 'tool_call', data: { name: 'emitProposalNode' } });
      const parsed = ProposalNodeSchema.safeParse(node);
      if (!parsed.success) {
        ctx.emitEvent({
          type: 'tool_result',
          data: { name: 'emitProposalNode', ok: false, error: parsed.error.message },
        });
        return {
          ok: false as const,
          error: `Validation failed: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        };
      }
      try {
        await ctx.emitNode(parsed.data);
        ctx.emitEvent({
          type: 'node_emitted',
          data: {
            kind: parsed.data.kind,
            clientId: parsed.data.clientId,
            confidence: parsed.data.confidence,
          },
        });
        return { ok: true as const, clientId: parsed.data.clientId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: message };
      }
    },
  });
}

export function finalizeProposalTool(ctx: AgentToolContext) {
  return tool({
    description:
      'Signal that the proposal is complete. Call this exactly once, at the end. After calling this, the run is moved to awaiting_review and the admin can open the review screen.',
    inputSchema: z.object({
      summary: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'One paragraph summary of what you proposed. The admin reads this first.',
        ),
      warnings: z
        .array(z.string().max(500))
        .default([])
        .describe(
          'Anything the admin should double-check (low confidence, ambiguous files, possible safety-critical content, etc.).',
        ),
    }),
    execute: async ({ summary, warnings }) => {
      ctx.emitEvent({ type: 'tool_call', data: { name: 'finalizeProposal' } });
      await ctx.finalize({ summary, warnings });
      ctx.emitEvent({ type: 'finalize', data: { summary, warningCount: warnings.length } });
      return { ok: true as const };
    },
  });
}
