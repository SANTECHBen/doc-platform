// Build a natural-language spoken preview for voice-search results. The
// PWA plays this via /ai/voice/speak so the tech hears the answer hands-
// free; the visible list lets them tap for nav.
//
// Tone: terse, second-person, imperative. No filler. If the top result
// looks confident, name it explicitly; if there are multiple plausible
// matches, count them and name the top one only.

import type { SearchHit } from '@platform/ai';

export interface SpokenPreviewInput {
  transcript: string;
  hits: SearchHit[];
  /** True when the rerank was skipped (cold start, Voyage down). Avoid
   *  saying "the top result is" when we don't actually have a reranked
   *  ordering. */
  rerankSkipped?: boolean;
}

export interface SpokenPreview {
  /** Plain-text utterance fed to TTS. Keep under ~140 chars so playback
   *  is under ~6 seconds at normal speed. */
  text: string;
  /** Hint for the UI: 'confident' lets us auto-emphasize the top card. */
  confidence: 'none' | 'low' | 'confident';
}

const HIGH_CONFIDENCE_RERANK = 0.55;

export function buildSpokenPreview(input: SpokenPreviewInput): SpokenPreview {
  const { hits, rerankSkipped } = input;
  if (hits.length === 0) {
    return {
      text: 'I could not find a match for that. Try rephrasing.',
      confidence: 'none',
    };
  }

  const top = hits[0]!;
  const topTitle = sanitizeTitle(top.title);
  const docTitle = sanitizeTitle(getMetaString(top.metadata, 'docTitle') ?? '');
  const sectionTitle = sanitizeTitle(
    getMetaString(top.metadata, 'sectionTitle') ?? '',
  );

  // Phrasing varies by source type so the spoken response matches what
  // the tech sees on screen.
  let topDescription: string;
  switch (top.sourceType) {
    case 'procedure_step':
      topDescription = sectionTitle
        ? `step "${topTitle}" in ${docTitle || 'the procedure'} (${sectionTitle})`
        : `step "${topTitle}" in ${docTitle || 'the procedure'}`;
      break;
    case 'document_section':
      topDescription = docTitle
        ? `section "${topTitle}" in ${docTitle}`
        : `section "${topTitle}"`;
      break;
    case 'doc_chunk':
      topDescription = docTitle ? `from ${docTitle}` : topTitle;
      break;
  }

  const confidence: SpokenPreview['confidence'] = rerankSkipped
    ? 'low'
    : top.score >= HIGH_CONFIDENCE_RERANK
      ? 'confident'
      : 'low';

  if (hits.length === 1) {
    return {
      text: `Found one match — ${topDescription}.`,
      confidence,
    };
  }

  return {
    text: `Found ${hits.length} matches. Top result: ${topDescription}.`,
    confidence,
  };
}

function sanitizeTitle(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
}

function getMetaString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const v = metadata[key];
  return typeof v === 'string' ? v : null;
}
