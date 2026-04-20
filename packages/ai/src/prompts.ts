import type { SafetyFlaggedChunk } from './guardrails';

/**
 * When a conversation is scoped to a specific part inside an asset (via
 * partId on the chat request), the AI needs to know which part it is so
 * questions like "what assembly is this part in?" don't come back as
 * "which part?". Populated only for part-scoped chat turns.
 */
export interface PartContext {
  oemPartNumber: string;
  displayName: string;
  description: string | null;
  /** Positional ref on the parent asset's BOM (e.g., "E-217"). */
  positionRef: string | null;
  /** Name of the parent part if this part is itself a component. */
  parentPartDisplayName?: string | null;
  /** OEM number of the parent part if applicable. */
  parentOemPartNumber?: string | null;
}

export interface GroundingContext {
  assetModelDisplayName: string;
  assetModelCategory: string;
  serialNumber: string;
  siteName: string;
  contentPackVersionLabel: string | null;
  chunks: SafetyFlaggedChunk[];
  /** Optional — populated only when the chat is scoped to a specific part. */
  part?: PartContext | null;
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
  );

  // When a part is in scope, pin it at the top of the context so the model
  // always knows which specific part the user is asking about. Without this
  // the model falls back to "which part do you mean?" even though the UI is
  // visibly zoomed into one.
  if (ctx.part) {
    lines.push(
      '## Part in focus',
      'The user is currently viewing this specific part in the PWA. Answer in reference to it',
      'unless they explicitly ask about something else.',
      `- OEM part number: ${ctx.part.oemPartNumber}`,
      `- Name: ${ctx.part.displayName}`,
    );
    if (ctx.part.description) {
      lines.push(`- Description: ${ctx.part.description}`);
    }
    if (ctx.part.positionRef) {
      lines.push(`- Position on the asset's BOM: ${ctx.part.positionRef}`);
    }
    if (ctx.part.parentPartDisplayName) {
      lines.push(
        `- Parent assembly: ${ctx.part.parentPartDisplayName}` +
          (ctx.part.parentOemPartNumber ? ` (${ctx.part.parentOemPartNumber})` : ''),
      );
    } else {
      lines.push(
        `- Parent assembly: the ${ctx.assetModelDisplayName} itself (this is a top-level BOM part).`,
      );
    }
    lines.push('');
  }

  lines.push('## Source chunks', '');

  for (const chunk of ctx.chunks) {
    lines.push(`<chunk id="${chunk.id}"${chunk.safetyCritical ? ' safety_critical="true"' : ''}>`);
    lines.push(chunk.content);
    lines.push('</chunk>');
    lines.push('');
  }

  return lines.join('\n');
}
