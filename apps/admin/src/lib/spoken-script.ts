// Mirror of packages/api/src/routes/admin-procedure-audio.ts#buildSpokenScript.
// Used by the voiceover Generate-with-AI dialog (to pre-fill the editable
// textarea with what the server WOULD synthesize) and by the bulk-generate
// confirm dialog (to show a character-count estimate without a server
// round-trip).
//
// Keeping the two in sync is important — the dialog says "this is the
// script we'll send" and then either the dialog text or the server's
// derived script gets shipped. If the rules drift, users get confusing
// "the audio doesn't sound like what I saw."

import type { AdminProcedureStep, StepBlock } from '@/lib/api';

/** Flatten a procedure step into the spoken-script string ElevenLabs (or
 *  OpenAI) will narrate. Mirrors the API's buildSpokenScript exactly. */
export function buildSpokenScript(step: AdminProcedureStep): string {
  const lead = step.title.trim();
  let body = '';
  const blocks: StepBlock[] = step.blocks ?? [];
  if (blocks.length > 0) {
    const parts: string[] = [];
    for (const b of blocks) {
      switch (b.kind) {
        case 'paragraph':
          parts.push(b.text);
          break;
        case 'callout':
          parts.push(
            `${b.tone === 'safety' || b.tone === 'warning' ? `${b.tone}. ` : ''}${b.title ? b.title + '. ' : ''}${b.text}`,
          );
          break;
        case 'bullet_list':
        case 'numbered_list':
          parts.push(b.items.join('. '));
          break;
        case 'key_value':
          parts.push(b.rows.map((row) => `${row[0]}, ${row[1]}.`).join(' '));
          break;
        case 'photo_inline':
          if (b.caption) parts.push(b.caption);
          break;
      }
    }
    body = parts.filter((s) => s.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim();
  } else if (step.bodyMarkdown) {
    body = step.bodyMarkdown
      .replace(/[#>*_`]/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return body ? `${lead}. ${body}` : lead;
}

/** Convenience for callers that only need the character count (bulk
 *  generate confirm). Equivalent to buildSpokenScript(step).length. */
export function estimateSpokenChars(step: AdminProcedureStep): number {
  return buildSpokenScript(step).length;
}
