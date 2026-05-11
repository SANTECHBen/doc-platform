import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import { requireAuthOrScan } from '../middleware/scan-session';
import {
  computeSttCostCents,
  computeTtsCostCents,
  enforceVoiceQuota,
  getUsageSnapshot,
  maybeFireSpendAlarm,
  QuotaExceededError,
  recordVoiceUsage,
  resolveQuota,
  type VoiceQuotaKind,
} from '../lib/voice-quota';

// Resolve the org context for a voice request. Auth user takes precedence
// (their home org owns the cost). Falls back to the QR's owning org for
// scan-session traffic. Returns null if neither is present (callers should
// have already called requireAuthOrScan; this is belt-and-suspenders).
async function resolveQuotaContext(
  request: FastifyRequest,
  db: Database,
): Promise<{
  organizationId: string;
  organizationName: string;
  storedQuota: import('@platform/db').VoiceQuotaConfig | null;
  userId: string | null;
  assetInstanceId: string | null;
} | null> {
  const orgId = request.auth?.organizationId ?? request.scanSession?.organizationId;
  if (!orgId) return null;
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
    columns: { id: true, name: true, voiceQuota: true },
  });
  if (!org) return null;
  return {
    organizationId: org.id,
    organizationName: org.name,
    storedQuota: org.voiceQuota ?? null,
    userId: request.auth?.userId ?? null,
    assetInstanceId: request.scanSession?.assetInstanceId ?? null,
  };
}

// Translate a thrown quota error into a 429 response. Returns true if it
// handled the error (caller should not continue), false otherwise.
function maybeReplyQuotaExceeded(
  err: unknown,
  reply: FastifyReply,
): err is QuotaExceededError {
  if (err instanceof QuotaExceededError) {
    reply.header('retry-after', String(err.retryAfterSeconds));
    reply.code(429).send({
      error: err.message,
      reason: err.reason,
      retryAfterSeconds: err.retryAfterSeconds,
    });
    return true;
  }
  return false;
}

// Voice I/O for the AI-first scan experience.
//
//   POST /ai/voice/transcribe   multipart audio file → { text }
//   POST /ai/voice/speak        { text, voice? }      → audio/mpeg stream
//
// Both proxy OpenAI. We use fetch directly (no SDK) to keep the dependency
// surface tiny — it's a single field and a single endpoint each. When
// OPENAI_API_KEY is not set, the routes return 503 with a clear hint so the
// PWA can degrade gracefully (hide the mic button, fall back to text-only
// voice mode).

const SpeakBodySchema = z.object({
  text: z.string().min(1).max(4000),
  // Optional voice override — defaults to env.OPENAI_TTS_VOICE.
  voice: z
    .enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'])
    .optional(),
  // 'speed' lets the PWA hint a slower cadence for safety-critical step-by-step
  // playback. OpenAI TTS supports 0.25–4.0; we clamp to a sane band.
  speed: z.coerce.number().min(0.5).max(2.0).optional(),
  format: z.enum(['mp3', 'opus', 'aac', 'wav']).default('mp3'),
});

export async function registerVoiceRoutes(app: FastifyInstance) {
  // STT — multipart upload of a short audio clip (≤25 MB per Whisper limit).
  // Body must be multipart/form-data with a single 'audio' file field.
  // Anyone with auth or a valid scan session can transcribe — there's no
  // scope concern here; the audio is the user's own utterance.
  app.post('/ai/voice/transcribe', async (request, reply) => {
    const { env, db } = app.ctx;
    requireAuthOrScan(request);
    if (!env.OPENAI_API_KEY) {
      return reply
        .code(503)
        .send({ error: 'Voice transcription is not configured (OPENAI_API_KEY).' });
    }
    if (!request.isMultipart()) {
      return reply.badRequest('Expected multipart/form-data with an audio file.');
    }

    // Resolve quota context up front so a quota breach short-circuits before
    // we burn time pulling the audio body off the wire. Note: STT cost can't
    // be predicted from headers (we only know duration after Whisper sees
    // it), so the pre-flight check is daily-turns + monthly-$ only.
    const ctx = await resolveQuotaContext(request, db);
    if (!ctx) return reply.unauthorized();
    try {
      await enforceVoiceQuota(db, ctx.organizationId, ctx.storedQuota, 'stt');
    } catch (err) {
      if (maybeReplyQuotaExceeded(err, reply)) return;
      throw err;
    }

    const file = await request.file();
    if (!file) return reply.badRequest('Missing audio file.');

    const chunks: Buffer[] = [];
    for await (const c of file.file as unknown as AsyncIterable<Buffer>) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (buf.byteLength === 0) return reply.badRequest('Empty audio.');
    if (buf.byteLength > 25 * 1024 * 1024) {
      return reply.payloadTooLarge('Audio exceeds 25 MB limit for transcription.');
    }

    const form = new FormData();
    const blob = new Blob([buf], {
      type: file.mimetype || 'audio/webm',
    });
    form.append('file', blob, file.filename || 'recording.webm');
    form.append('model', env.OPENAI_STT_MODEL);
    // verbose_json gives us duration in seconds — needed for accurate
    // cost accounting against Whisper's per-minute pricing. The shape
    // is a strict superset of plain json, so the response handling stays
    // simple.
    form.append('response_format', 'verbose_json');
    // Hint the model with our domain. Industrial maintenance vocabulary:
    // fault codes (E-217, ALM-12), part numbers, OEM jargon. Whisper uses
    // the prompt as a soft prior, not a hard constraint — safe to over-hint.
    form.append(
      'prompt',
      'Industrial maintenance technician describing equipment, fault codes, part numbers, and procedures.',
    );

    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      request.log.error({ status: upstream.status, text }, 'Whisper STT failed');
      return reply.internalServerError('Transcription failed.');
    }
    const json = (await upstream.json()) as { text?: string; duration?: number };
    const seconds = Math.max(1, Math.ceil(json.duration ?? 0));

    // Record + alarm. Detached from the response — we still want to return
    // the transcript even if the ledger write hiccups.
    void recordAndAlarm({
      app,
      ctx,
      kind: 'stt',
      units: seconds,
      costCents: computeSttCostCents(seconds),
      log: request.log,
    });

    return reply.send({ text: (json.text ?? '').trim() });
  });

  // TTS — streams the synthesized audio straight through. Browsers can play
  // the response with HTMLAudioElement or MediaSource for true streaming.
  app.post('/ai/voice/speak', { schema: { body: SpeakBodySchema } }, async (request, reply) => {
    const { env, db } = app.ctx;
    requireAuthOrScan(request);

    // Pick provider: ElevenLabs takes priority when configured, falls back
    // to OpenAI. Both providers can be unset → 503.
    const useElevenLabs = !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
    if (!useElevenLabs && !env.OPENAI_API_KEY) {
      return reply
        .code(503)
        .send({
          error:
            'Voice synthesis is not configured (set ELEVENLABS_API_KEY+ELEVENLABS_VOICE_ID, or OPENAI_API_KEY).',
        });
    }

    const body = request.body as z.infer<typeof SpeakBodySchema>;
    const charsToSynthesize = body.text.length;

    // Pre-flight quota check. We know the exact char count up-front, so we
    // pass it as additionalUnits — the monthly TTS cap rejects requests
    // that *would* push us over the line, not just ones that already have.
    const ctx = await resolveQuotaContext(request, db);
    if (!ctx) return reply.unauthorized();
    try {
      await enforceVoiceQuota(db, ctx.organizationId, ctx.storedQuota, 'tts', charsToSynthesize);
    } catch (err) {
      if (maybeReplyQuotaExceeded(err, reply)) return;
      throw err;
    }

    let upstream: Response;
    let billingModel: string;
    if (useElevenLabs) {
      billingModel = env.ELEVENLABS_MODEL_ID;
      // ElevenLabs format mapping. Their output_format param wants codec +
      // sample rate + bitrate. Default Flash output is mp3_44100_128.
      const outputFormat =
        body.format === 'mp3'
          ? 'mp3_44100_128'
          : body.format === 'opus'
            ? 'opus_48000_64'
            : body.format === 'aac'
              ? 'mp3_44100_128' // ElevenLabs has no AAC — fall back to mp3
              : 'pcm_44100';
      upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=${outputFormat}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': env.ELEVENLABS_API_KEY!,
            'content-type': 'application/json',
            accept: body.format === 'mp3' ? 'audio/mpeg' : 'audio/*',
          },
          body: JSON.stringify({
            text: body.text,
            model_id: env.ELEVENLABS_MODEL_ID,
            // Reasonable defaults; tunable later if Ben wants more/less
            // emotion. Stability balances consistency vs expressiveness.
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0,
              use_speaker_boost: true,
            },
          }),
        },
      );
    } else {
      billingModel = env.OPENAI_TTS_MODEL;
      const voice = body.voice ?? env.OPENAI_TTS_VOICE;
      upstream = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.OPENAI_API_KEY!}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.OPENAI_TTS_MODEL,
          voice,
          input: body.text,
          format: body.format,
          ...(body.speed ? { speed: body.speed } : {}),
        }),
      });
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      request.log.error(
        { status: upstream.status, text, provider: useElevenLabs ? 'elevenlabs' : 'openai' },
        'TTS provider failed',
      );
      return reply.internalServerError('Speech synthesis failed.');
    }

    const mime =
      body.format === 'mp3'
        ? 'audio/mpeg'
        : body.format === 'opus'
          ? 'audio/ogg'
          : body.format === 'aac'
            ? 'audio/aac'
            : 'audio/wav';

    reply.raw.setHeader('content-type', mime);
    reply.raw.setHeader('cache-control', 'no-store');
    reply.raw.setHeader('x-accel-buffering', 'no');

    // Echo CORS for browsers — Fastify's CORS plugin doesn't run when we
    // hijack the reply.
    const origin = request.headers.origin;
    if (origin && (origin === env.PUBLIC_PWA_ORIGIN || origin === env.PUBLIC_ADMIN_ORIGIN)) {
      reply.raw.setHeader('access-control-allow-origin', origin);
      reply.raw.setHeader('access-control-allow-credentials', 'true');
      reply.raw.setHeader('vary', 'origin');
    }
    reply.hijack();

    // Record usage now — synth has been authorized and we know the char
    // count; even if the network drops mid-stream, vendor cost is incurred
    // (OpenAI bills on input chars, not delivered audio bytes).
    void recordAndAlarm({
      app,
      ctx,
      kind: 'tts',
      units: charsToSynthesize,
      costCents: computeTtsCostCents(charsToSynthesize, billingModel),
      log: request.log,
    });

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) reply.raw.write(Buffer.from(value));
      }
    } catch (err) {
      request.log.error({ err }, 'TTS stream interrupted');
    } finally {
      reply.raw.end();
    }
  });
}

// Detached usage write + alarm check. Run after the upstream call has been
// authorized — by this point the vendor cost is incurred regardless of
// what happens to the client connection. Errors only log; we never want a
// ledger hiccup to fail a paying customer's voice turn.
async function recordAndAlarm(args: {
  app: FastifyInstance;
  ctx: NonNullable<Awaited<ReturnType<typeof resolveQuotaContext>>>;
  kind: VoiceQuotaKind;
  units: number;
  costCents: number;
  log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}) {
  const { db, env } = args.app.ctx;
  try {
    await recordVoiceUsage(db, {
      organizationId: args.ctx.organizationId,
      userId: args.ctx.userId,
      assetInstanceId: args.ctx.assetInstanceId,
      kind: args.kind,
      units: args.units,
      costCents: args.costCents,
    });
    const fresh = await getUsageSnapshot(db, args.ctx.organizationId);
    maybeFireSpendAlarm({
      webhookUrl: env.VOICE_ALERT_SLACK_WEBHOOK ?? undefined,
      organizationId: args.ctx.organizationId,
      organizationName: args.ctx.organizationName,
      quota: resolveQuota(args.ctx.storedQuota),
      snapshot: fresh,
      log: args.log,
    });
  } catch (err) {
    args.log.error('voice usage record failed', err);
  }
}
