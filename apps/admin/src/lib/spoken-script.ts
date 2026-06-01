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
 *  OpenAI) will narrate. Mirrors the API's buildSpokenScript exactly.
 *
 *  Scope: title is the step itself (the canonical instruction). Paragraph
 *  blocks are sub-text that elaborate on the step. Everything else
 *  (callouts, lists, key-value tables, photo captions) is intentionally
 *  EXCLUDED from the spoken script — those are visual-only authoring
 *  affordances. A photo caption like "Align Sprockets" describes the
 *  image for the tech's eyes, not narration. Authors who want a callout
 *  spoken should restate it in the title or a paragraph. */
export function buildSpokenScript(step: AdminProcedureStep): string {
  const lead = step.title.trim();
  let body = '';
  const blocks: StepBlock[] = step.blocks ?? [];
  if (blocks.length > 0) {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.kind === 'paragraph') {
        parts.push(b.text);
      }
      // Other block kinds (callout, bullet_list, numbered_list,
      // key_value, photo_inline) are deliberately silent — see
      // function doc above.
    }
    body = parts.filter((s) => s.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim();
  } else if (step.bodyMarkdown) {
    // Legacy bodyMarkdown still flows through — it predates blocks and
    // was the only authoring surface for many existing steps. Strip
    // markdown noise so the TTS doesn't read symbols aloud.
    body = step.bodyMarkdown
      .replace(/[#>*_`]/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return body ? joinSentences(lead, body) : lead;
}

/** Join two narration chunks with a single ". " separator — but only
 *  when the first chunk doesn't already end in sentence-terminating
 *  punctuation. Avoids the double-period when a title is itself a full
 *  sentence ("Verify the sprockets... .. Align Sprockets"). */
function joinSentences(a: string, b: string): string {
  const left = a.replace(/\s+$/, '');
  const right = b.replace(/^\s+/, '');
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const endsWithStop = /[.!?]$/.test(left);
  return `${left}${endsWithStop ? ' ' : '. '}${right}`;
}

/** Convenience for callers that only need the character count (bulk
 *  generate confirm). Equivalent to buildSpokenScript(step).length. */
export function estimateSpokenChars(step: AdminProcedureStep): number {
  return buildSpokenScript(step).length;
}
