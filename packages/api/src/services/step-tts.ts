// Shared TTS synthesis helper for AUTHORED (pre-rendered) voiceovers —
// per-step in admin-procedure-audio.ts, per-snippet in admin-snippet-audio.ts,
// and the AI walkthrough drafter's executor.
//
// Provider selection
//   When ElevenLabs is configured (api key + voice id), we prefer it. The
//   author's "Generate with AI" button is provider-agnostic — the route picks
//   whichever provider the env enables. OpenAI tts-1-hd stays as the
//   automatic fallback so generation never 503s when ElevenLabs creds are
//   missing.
//
// Cost shape
//   ElevenLabs bills per-character against the org's monthly subscription
//   quota; OpenAI bills per-character at vendor-priced rates per million.
//   Either way the audio is generated once, stored content-addressed in
//   R2, and replayed free forever.

import type { Storage } from '../storage.js';

/** Concrete provider that synthesized the audio. Surfaced back to callers so
 *  the audit log and the admin UI can report which path ran. */
export type TtsProvider = 'openai' | 'elevenlabs';

export interface SynthesizeStepTtsParams {
  text: string;
  storage: Storage;
  /** Used as the storage filename prefix. Should already be sanitized
   *  (no path separators); the indexer appends a content discriminator. */
  filenameStem: string;
  /** Owner organization for tenant-prefixed key. Required — derived from
   *  the procedure / pack the step belongs to. */
  ownerOrganizationId: string;
  /** Force a specific provider. Default: auto-select (elevenlabs when
   *  configured, otherwise openai). */
  provider?: TtsProvider;
  /** ElevenLabs config. When provider resolves to 'elevenlabs', all three
   *  must be supplied — caller pulls them from env. */
  elevenlabs?: {
    apiKey: string;
    voiceId: string;
    modelId: string;
  };
  /** OpenAI config. When provider resolves to 'openai', both must be
   *  supplied — caller pulls them from env. */
  openai?: {
    apiKey: string;
    voice: string;
    model: string;
  };
}

export interface SynthesizeStepTtsResult {
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  /** Filled by the client-side audio probe; we don't shell out to ffmpeg
   *  here, so the server-side value stays null/0. The runner is happy with
   *  this — it probes on first play. */
  durationMs: number;
  /** Provider that actually ran. Caller logs this in the audit row. */
  provider: TtsProvider;
  /** Model that actually ran (e.g. 'eleven_multilingual_v2', 'tts-1-hd'). */
  model: string;
  /** Voice that actually ran (ElevenLabs voice id, or OpenAI voice name). */
  voice: string;
  /** Source character count — useful for the bulk-generate UI to estimate
   *  total characters before firing. */
  charCount: number;
}

/** Decide which provider to use. Caller passes a `provider` override
 *  (which we honor literally) OR omits it (we pick ElevenLabs when
 *  configured, OpenAI otherwise). Throws if neither side has creds. */
export function resolveTtsProvider(args: {
  provider?: TtsProvider;
  hasElevenLabs: boolean;
  hasOpenAi: boolean;
}): TtsProvider {
  if (args.provider === 'elevenlabs') {
    if (!args.hasElevenLabs) {
      throw new Error(
        'ElevenLabs requested but not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.',
      );
    }
    return 'elevenlabs';
  }
  if (args.provider === 'openai') {
    if (!args.hasOpenAi) {
      throw new Error('OpenAI requested but OPENAI_API_KEY is not set.');
    }
    return 'openai';
  }
  // Auto: ElevenLabs wins when configured (better voice quality and the
  // user is paying for the subscription anyway). Otherwise OpenAI.
  if (args.hasElevenLabs) return 'elevenlabs';
  if (args.hasOpenAi) return 'openai';
  throw new Error(
    'No TTS provider configured. Set ELEVENLABS_API_KEY (preferred) or OPENAI_API_KEY.',
  );
}

export async function synthesizeStepTts(
  params: SynthesizeStepTtsParams,
): Promise<SynthesizeStepTtsResult> {
  const {
    text,
    storage,
    filenameStem,
    ownerOrganizationId,
    provider: requestedProvider,
    elevenlabs,
    openai,
  } = params;

  const provider = resolveTtsProvider({
    provider: requestedProvider,
    hasElevenLabs: !!(elevenlabs?.apiKey && elevenlabs?.voiceId),
    hasOpenAi: !!openai?.apiKey,
  });

  let audioBuf: Buffer;
  let model: string;
  let voice: string;

  if (provider === 'elevenlabs') {
    if (!elevenlabs) {
      throw new Error('ElevenLabs config missing.');
    }
    model = elevenlabs.modelId;
    voice = elevenlabs.voiceId;
    // ElevenLabs returns the audio body directly; output_format must be
    // declared in the query string. We pick mp3_44100_128 — standard
    // quality, matches the storage layer's content-type handling.
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      elevenlabs.voiceId,
    )}?output_format=mp3_44100_128`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenlabs.apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: elevenlabs.modelId,
        // Authored audio tends toward narration / instruction. Slightly
        // higher stability than the live-voice defaults (which favor
        // expressiveness) so safety-critical content stays unambiguous.
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
        },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ElevenLabs TTS ${resp.status}: ${errText}`);
    }
    audioBuf = Buffer.from(await resp.arrayBuffer());
  } else {
    if (!openai) {
      throw new Error('OpenAI config missing.');
    }
    model = openai.model;
    voice = openai.voice;
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openai.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: openai.model,
        voice: openai.voice,
        input: text,
        format: 'mp3',
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI TTS ${resp.status}: ${errText}`);
    }
    audioBuf = Buffer.from(await resp.arrayBuffer());
  }

  if (audioBuf.byteLength === 0) {
    throw new Error(`${provider} TTS returned empty audio`);
  }
  const stored = await storage.putBuffer({
    buffer: audioBuf,
    filename: `${filenameStem}.mp3`,
    contentType: 'audio/mpeg',
    ownerOrganizationId,
  });
  return {
    storageKey: stored.storageKey,
    sizeBytes: stored.size,
    contentType: 'audio/mpeg',
    durationMs: 0,
    provider,
    model,
    voice,
    charCount: text.length,
  };
}
