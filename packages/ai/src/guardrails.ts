import type { RetrievedChunk } from './retrieval';

/**
 * Safety-critical guardrail: if ANY retrieved chunk comes from a document flagged
 * safety_critical, the assistant MUST quote those chunks verbatim rather than
 * paraphrase. This is enforced by:
 *   1. A system-prompt directive.
 *   2. A post-hoc check that verbatim spans from safety-critical chunks appear
 *      in the response when they are used as grounding.
 *
 * Non-negotiable for MHE/IA content where misstating a procedure can kill someone.
 */
export interface SafetyFlaggedChunk extends RetrievedChunk {
  safetyCritical: boolean;
}

export function buildSafetyDirective(chunks: SafetyFlaggedChunk[]): string {
  const safetyChunks = chunks.filter((c) => c.safetyCritical);
  if (safetyChunks.length === 0) return '';

  return [
    '',
    '## SAFETY-CRITICAL GROUNDING',
    '',
    'One or more retrieved chunks are marked safety-critical. When referencing',
    'information from a safety-critical chunk you MUST:',
    '  1. Quote the relevant text verbatim (exact characters).',
    '  2. Include the citation tag for the quote.',
    '  3. Not paraphrase, summarize, or abbreviate the safety-critical content.',
    '  4. If the user asks for a summary, respond that you will quote the exact',
    '     procedure and then quote it.',
    '',
    'This applies only to chunks explicitly marked with `safety_critical: true`',
    'in their source tag.',
  ].join('\n');
}

/**
 * Basic verifier: for each safety-critical chunk in the grounding, confirm that
 * either (a) it is not referenced by the response, or (b) a verbatim substring
 * of length >= minQuoteLen appears in the response text.
 *
 * Returns a list of violations. Empty = pass.
 */
export function verifyVerbatimQuotes(params: {
  response: string;
  groundingChunks: SafetyFlaggedChunk[];
  referencedChunkIds: Set<string>;
  minQuoteLen?: number;
}): Array<{ chunkId: string; reason: string }> {
  const minLen = params.minQuoteLen ?? 30;
  const violations: Array<{ chunkId: string; reason: string }> = [];
  for (const chunk of params.groundingChunks) {
    if (!chunk.safetyCritical) continue;
    if (!params.referencedChunkIds.has(chunk.id)) continue;
    // Pick a stable substring from the chunk (first minLen non-ws chars).
    const sample = chunk.content.slice(0, Math.min(minLen, chunk.content.length));
    if (!params.response.includes(sample)) {
      violations.push({
        chunkId: chunk.id,
        reason: `Safety-critical chunk was referenced but no verbatim quote found.`,
      });
    }
  }
  return violations;
}
