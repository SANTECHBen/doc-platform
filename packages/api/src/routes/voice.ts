import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuthOrScan } from '../middleware/scan-session';

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
    const { env } = app.ctx;
    requireAuthOrScan(request);
    if (!env.OPENAI_API_KEY) {
      return reply
        .code(503)
        .send({ error: 'Voice transcription is not configured (OPENAI_API_KEY).' });
    }
    if (!request.isMultipart()) {
      return reply.badRequest('Expected multipart/form-data with an audio file.');
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
    form.append('response_format', 'json');
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
    const json = (await upstream.json()) as { text?: string };
    return reply.send({ text: (json.text ?? '').trim() });
  });

  // TTS — streams the synthesized audio straight through. Browsers can play
  // the response with HTMLAudioElement or MediaSource for true streaming.
  app.post('/ai/voice/speak', { schema: { body: SpeakBodySchema } }, async (request, reply) => {
    const { env } = app.ctx;
    requireAuthOrScan(request);
    if (!env.OPENAI_API_KEY) {
      return reply
        .code(503)
        .send({ error: 'Voice synthesis is not configured (OPENAI_API_KEY).' });
    }
    const body = request.body as z.infer<typeof SpeakBodySchema>;
    const voice = body.voice ?? env.OPENAI_TTS_VOICE;

    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
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
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      request.log.error({ status: upstream.status, text }, 'OpenAI TTS failed');
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
