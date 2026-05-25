// Shared TTS synthesis helper. Originally inlined inside
// admin-procedure-audio.ts; extracted so the drafter executor can reuse
// the exact same OpenAI request + storage write pattern without dragging
// the route handler along.
//
// Returns the storage key so the caller can attach it as
// procedure_steps.audio_storage_key. durationMs is filled in client-side
// later (we'd otherwise need ffmpeg to probe the mp3 here; not worth it).

import type { Storage } from '../storage.js';

export interface SynthesizeStepTtsParams {
  text: string;
  voice: string;
  model: string;
  openaiApiKey: string;
  storage: Storage;
  /** Used as the storage filename prefix. Should already be sanitized
   *  (no path separators); the indexer appends a content discriminator. */
  filenameStem: string;
  /** Owner organization for tenant-prefixed key. Required — derived from
   *  the procedure / pack the step belongs to. */
  ownerOrganizationId: string;
}

export interface SynthesizeStepTtsResult {
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  /** Filled by the client-side audio probe; we don't shell out to ffmpeg
   *  here, so the server-side value stays null. The runner is happy with
   *  this — it probes on first play. */
  durationMs: number;
}

export async function synthesizeStepTts(
  params: SynthesizeStepTtsParams,
): Promise<SynthesizeStepTtsResult> {
  const { text, voice, model, openaiApiKey, storage, filenameStem, ownerOrganizationId } = params;
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, voice, input: text, format: 'mp3' }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenAI TTS ${resp.status}: ${errText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error('OpenAI TTS returned empty audio');
  }
  const stored = await storage.putBuffer({
    buffer: buf,
    filename: `${filenameStem}.mp3`,
    contentType: 'audio/mpeg',
    ownerOrganizationId,
  });
  return {
    storageKey: stored.storageKey,
    sizeBytes: stored.size,
    contentType: 'audio/mpeg',
    durationMs: 0,
  };
}
