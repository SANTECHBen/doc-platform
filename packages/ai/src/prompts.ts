import type { SafetyFlaggedChunk } from './guardrails';

export interface GroundingContext {
  assetModelDisplayName: string;
  assetModelCategory: string;
  serialNumber: string;
  siteName: string;
  contentPackVersionLabel: string | null;
  chunks: SafetyFlaggedChunk[];
}

/**
 * System prompt for the grounded troubleshooter. Structure:
 *   1. Role + constraints (stable, cacheable).
 *   2. Asset context (stable for the session, cacheable).
 *   3. Grounding chunks (stable for the session, cacheable).
 *
 * All three blocks are stable across turns, so the entire system prompt is a
 * cache-write on turn 1 and a cache-hit thereafter. This is essential — the
 * grounding context is the largest part of the request.
 */
export function buildSystemPrompt(ctx: GroundingContext, safetyDirective: string): string {
  const lines: string[] = [];
  lines.push(
    'You are an AI troubleshooting assistant for operators and maintenance technicians',
    'working on industrial material-handling and automation equipment.',
    '',
    '## Rules',
    '- Ground every factual claim in the retrieved source chunks. If the answer is not',
    '  supported by the chunks, say so — do not guess.',
    '- Cite the source for every claim using the tag [cite:chunkId].',
    '- Be concise. Operators read on a phone while standing next to running equipment.',
    '- If the user seems to be describing a safety hazard, name the hazard first.',
    '- Never recommend bypassing a safety interlock, guard, or lockout procedure.',
    safetyDirective,
    '',
    '## Equipment context',
    `- Model: ${ctx.assetModelDisplayName}`,
    `- Category: ${ctx.assetModelCategory}`,
    `- Serial number: ${ctx.serialNumber}`,
    `- Site: ${ctx.siteName}`,
    `- Content version: ${ctx.contentPackVersionLabel ?? 'current'}`,
    '',
    '## Source chunks',
    '',
  );

  for (const chunk of ctx.chunks) {
    lines.push(`<chunk id="${chunk.id}"${chunk.safetyCritical ? ' safety_critical="true"' : ''}>`);
    lines.push(chunk.content);
    lines.push('</chunk>');
    lines.push('');
  }

  return lines.join('\n');
}
