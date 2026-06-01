// Admin authoring API for per-step voiceover audio. Lets the author:
//
//   POST   /admin/procedure-steps/:id/audio              upload MP3/M4A
//   POST   /admin/procedure-steps/:id/audio/generate     synthesize via OpenAI TTS
//   DELETE /admin/procedure-steps/:id/audio              clear
//
// Voiceover is the centerpiece of the authored runner experience —
// pre-recorded narration plays at run time instead of live TTS, which
// gives a) custom emphasis / pacing on safety-critical steps, b) a
// distinct shop voice, and c) zero per-play vendor cost. Generated
// audio is stored once in S3 and replayed from there.

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import type { StepBlock } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import { sniffMime } from '../lib/mime-sniff.js';
import { recordAudit } from '../lib/audit.js';
import { synthesizeStepTts } from '../services/step-tts.js';

const ACCEPT_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
]);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB — plenty for a long step
const AUDIO_GEN_VOICE_FALLBACK = 'onyx';

interface StepCtx {
  step: typeof schema.procedureSteps.$inferSelect;
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
}

async function loadStepForWrite(
  db: Database,
  stepId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<StepCtx | null> {
  const step = await db.query.procedureSteps.findFirst({
    where: eq(schema.procedureSteps.id, stepId),
  });
  if (!step) return null;
  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, step.documentId),
    with: { packVersion: { with: { pack: true } } },
  });
  if (!doc) return null;
  requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
  return {
    step,
    doc,
    ownerOrganizationId: doc.packVersion.pack.ownerOrganizationId,
  };
}

// Best-effort duration probe via WebAudio's container metadata. We don't
// run a real audio decoder server-side (would add ffmpeg), so this is a
// rough estimate read from the bytes' first frames. The admin UI re-probes
// on the client (HTMLAudioElement.duration after preload='metadata') and
// PATCHes the accurate value back when known.
function estimateDurationMsFromBytes(_buf: Buffer, _mime: string): number | null {
  // Heuristic placeholder — the client probe is reliable enough that we
  // don't need this on first write. Returning null is fine; admin UI fills
  // it in via the PATCH /admin/procedure-steps/:id route's existing
  // updatedAt path on next save.
  return null;
}

// Strip markdown noise so the synthesized voiceover doesn't read symbols
// aloud, and flatten typed blocks into spoken prose. Mirrors what
// VirtualJobAid does for live TTS so the authored audio sounds the same
// as the live voice would. Without the blocks branch, modern blocks-based
// steps synthesized only their title (bodyMarkdown is unused once an
// author moves to the block editor).
function buildSpokenScript(input: {
  title: string;
  bodyMarkdown: string | null;
  blocks: StepBlock[] | null;
}): string {
  const lead = input.title.trim();
  let body = '';
  const blocks = input.blocks ?? [];
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
          parts.push(
            b.rows.map((row) => `${row[0]}, ${row[1]}.`).join(' '),
          );
          break;
        case 'photo_inline':
          if (b.caption) parts.push(b.caption);
          break;
      }
    }
    body = parts.filter((s) => s.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim();
  } else if (input.bodyMarkdown) {
    body = input.bodyMarkdown
      .replace(/[#>*_`]/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return body ? `${lead}. ${body}` : lead;
}

const GenerateBody = z.object({
  // Optional explicit voice override — only applies to the OpenAI path.
  // ElevenLabs voice is configured at the deploy level (one voice = one
  // brand sound) and not selectable per-request in this version.
  voice: z
    .enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'])
    .optional(),
  // Optional override of the spoken script. Defaults to step title +
  // body. Lets the author reword the audio without changing the on-screen
  // text (e.g. "Tighten to 25 newton-meters" vs. on-screen "25 N·m").
  script: z.string().min(2).max(4000).optional(),
  // Optional provider override. Default: ElevenLabs when configured,
  // otherwise OpenAI. UI doesn't expose this — only used by ops / tests
  // to pin a specific provider.
  provider: z.enum(['openai', 'elevenlabs']).optional(),
});

export async function registerAdminProcedureAudioRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /admin/procedure-steps/:id/audio  (multipart upload)
  //
  // Accepts a single audio file, validates mime + size, stores to the
  // configured object store, and writes the storage key + content type
  // + size into the procedure_steps row. Replaces any existing audio on
  // the step (one voiceover per step).
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/procedure-steps/:id/audio',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data with an audio file.');
      }
      const file = await request.file();
      if (!file) return reply.badRequest('Missing audio file.');

      const mime = (file.mimetype || '').toLowerCase();
      if (!ACCEPT_MIMES.has(mime)) {
        return reply.unsupportedMediaType(
          `Unsupported audio type: ${mime}. Use MP3, M4A, AAC, OGG, WAV, or WebM.`,
        );
      }

      const chunks: Buffer[] = [];
      for await (const c of file.file as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.byteLength === 0) return reply.badRequest('Empty audio.');
      if (buf.byteLength > MAX_AUDIO_BYTES) {
        return reply.payloadTooLarge('Audio exceeds 25 MB limit.');
      }
      // Magic-byte verification — never trust client-asserted MIME.
      const sniffed = sniffMime(buf);
      const SAFE_AUDIO = new Set([
        'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm',
      ]);
      if (!sniffed || !SAFE_AUDIO.has(sniffed)) {
        return reply.unsupportedMediaType(
          `File content does not match a supported audio format.`,
        );
      }
      // Use the sniffed MIME for storage — disregards the client claim.
      const verifiedMime = sniffed;

      const stored = await storage.putBuffer({
        buffer: buf,
        filename: file.filename || `step-${ctx.step.id}.audio`,
        contentType: verifiedMime,
        ownerOrganizationId: ctx.ownerOrganizationId,
      });

      const [updated] = await db
        .update(schema.procedureSteps)
        .set({
          audioStorageKey: stored.storageKey,
          audioContentType: mime,
          audioSizeBytes: stored.size,
          audioDurationMs: estimateDurationMsFromBytes(buf, mime),
          audioSource: 'uploaded',
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSteps.id, ctx.step.id))
        .returning();

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.audio_uploaded',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: {
          mime,
          sizeBytes: stored.size,
        },
      });

      return reply.send({
        audioUrl: storage.publicUrl(stored.storageKey),
        audioContentType: mime,
        audioSizeBytes: stored.size,
        audioSource: 'uploaded' as const,
        updatedAt: updated?.updatedAt.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/procedure-steps/:id/audio/generate
  //
  // One-shot synthesize via OpenAI TTS-1-HD, store the resulting MP3 in
  // the object store, write the storage key onto the row. Cost is ~$0.024
  // for an average step and the audio plays free forever — far cheaper
  // than per-run TTS even for moderate scan volumes. Re-callable: replaces
  // any previous audio on the step.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: z.infer<typeof GenerateBody> }>(
    '/admin/procedure-steps/:id/audio/generate',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: GenerateBody,
      },
    },
    async (request, reply) => {
      const { db, storage, env } = app.ctx;
      const hasElevenLabs = !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
      const hasOpenAi = !!env.OPENAI_API_KEY;
      if (!hasElevenLabs && !hasOpenAi) {
        return reply.code(503).send({
          error:
            'Audio generation requires ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (preferred) or OPENAI_API_KEY.',
        });
      }
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      const script = request.body.script ?? buildSpokenScript({
        title: ctx.step.title,
        bodyMarkdown: ctx.step.bodyMarkdown,
        blocks: ctx.step.blocks ?? [],
      });
      const openaiVoice =
        request.body.voice ?? env.OPENAI_TTS_VOICE ?? AUDIO_GEN_VOICE_FALLBACK;

      let synth;
      try {
        synth = await synthesizeStepTts({
          text: script,
          storage,
          filenameStem: `step-${ctx.step.id}-tts`,
          ownerOrganizationId: ctx.ownerOrganizationId,
          provider: request.body.provider,
          elevenlabs: hasElevenLabs
            ? {
                apiKey: env.ELEVENLABS_API_KEY!,
                voiceId: env.ELEVENLABS_VOICE_ID!,
                modelId: env.ELEVENLABS_TTS_MODEL_ID,
              }
            : undefined,
          openai: hasOpenAi
            ? {
                apiKey: env.OPENAI_API_KEY!,
                voice: openaiVoice,
                model: env.OPENAI_TTS_MODEL,
              }
            : undefined,
        });
      } catch (e) {
        request.log.error({ err: e }, 'TTS generate failed');
        return reply.internalServerError(
          e instanceof Error ? e.message : 'Audio synthesis failed.',
        );
      }

      const [updated] = await db
        .update(schema.procedureSteps)
        .set({
          audioStorageKey: synth.storageKey,
          audioContentType: 'audio/mpeg',
          audioSizeBytes: synth.sizeBytes,
          audioDurationMs: null, // client-side probe will fill this in
          audioSource: 'generated',
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSteps.id, ctx.step.id))
        .returning();

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.audio_generated',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: {
          provider: synth.provider,
          model: synth.model,
          voice: synth.voice,
          scriptChars: synth.charCount,
          sizeBytes: synth.sizeBytes,
        },
      });

      return reply.send({
        audioUrl: storage.publicUrl(synth.storageKey),
        audioContentType: 'audio/mpeg',
        audioSizeBytes: synth.sizeBytes,
        audioSource: 'generated' as const,
        voice: synth.voice,
        provider: synth.provider,
        model: synth.model,
        updatedAt: updated?.updatedAt.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/procedure-steps/:id/audio
  //
  // Clears the audio columns. We don't physically delete the stored
  // object — content-addressed storage means a future re-upload of the
  // same bytes will reuse it; orphaned blobs are cleaned by the storage
  // GC sweep separately.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/admin/procedure-steps/:id/audio',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      await db
        .update(schema.procedureSteps)
        .set({
          audioStorageKey: null,
          audioContentType: null,
          audioSizeBytes: null,
          audioDurationMs: null,
          audioSource: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSteps.id, ctx.step.id));

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.audio_deleted',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: {},
      });

      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/procedure-steps/:id/media (multipart upload)
  //
  // Attaches a photo (or video) to the step's media[] array. The author
  // can then reference the upload from a photo_inline block, or simply
  // let it render in the step's own gallery. Replaces nothing — appends.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/procedure-steps/:id/media',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();
      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data with a file.');
      }
      const file = await request.file();
      if (!file) return reply.badRequest('Missing file.');

      const mime = (file.mimetype || '').toLowerCase();
      const isImage = mime.startsWith('image/');
      const isVideo = mime.startsWith('video/');
      if (!isImage && !isVideo) {
        return reply.unsupportedMediaType(
          `Unsupported media type: ${mime}. Use an image or video.`,
        );
      }
      const MAX_BYTES = isVideo ? 200 * 1024 * 1024 : 25 * 1024 * 1024;

      const chunks: Buffer[] = [];
      for await (const c of file.file as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.byteLength === 0) return reply.badRequest('Empty file.');
      if (buf.byteLength > MAX_BYTES) {
        return reply.payloadTooLarge(
          `File exceeds ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit.`,
        );
      }

      const stored = await storage.putBuffer({
        buffer: buf,
        filename: file.filename || `step-${ctx.step.id}-media`,
        contentType: mime,
        ownerOrganizationId: ctx.ownerOrganizationId,
      });

      const next = [
        ...(ctx.step.media ?? []),
        {
          kind: isImage ? ('image' as const) : ('video' as const),
          storageKey: stored.storageKey,
          mime,
        },
      ];
      await db
        .update(schema.procedureSteps)
        .set({ media: next, updatedAt: new Date() })
        .where(eq(schema.procedureSteps.id, ctx.step.id));

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.media_added',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: { storageKey: stored.storageKey, mime, sizeBytes: stored.size },
      });

      return reply.send({
        storageKey: stored.storageKey,
        url: storage.publicUrl(stored.storageKey),
        kind: isImage ? 'image' : 'video',
        mime,
        sizeBytes: stored.size,
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/procedure-steps/:id/media/:storageKey  (URL-encoded)
  // Removes the entry from media[]; doesn't delete the underlying blob
  // (storage GC handles orphans).
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; storageKey: string } }>(
    '/admin/procedure-steps/:id/media/:storageKey',
    {
      schema: {
        params: z.object({
          id: UuidSchema,
          storageKey: z.string().min(1).max(800),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();
      const removeKey = request.params.storageKey;
      const next = (ctx.step.media ?? []).filter((m) => m.storageKey !== removeKey);
      await db
        .update(schema.procedureSteps)
        .set({ media: next, updatedAt: new Date() })
        .where(eq(schema.procedureSteps.id, ctx.step.id));
      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.media_removed',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: { storageKey: removeKey },
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-steps/:id/audio/duration
  //
  // Tiny endpoint the admin UI calls after probing duration in the
  // browser (HTMLAudioElement.duration). Server-side we don't have a
  // decoder, so we accept the client's value once and store it.
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: { audioDurationMs: number };
  }>(
    '/admin/procedure-steps/:id/audio/duration',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({ audioDurationMs: z.number().int().min(0).max(60 * 60 * 1000) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();
      if (!ctx.step.audioStorageKey) {
        return reply.badRequest('No audio attached to this step.');
      }
      await db
        .update(schema.procedureSteps)
        .set({ audioDurationMs: request.body.audioDurationMs, updatedAt: new Date() })
        .where(eq(schema.procedureSteps.id, ctx.step.id));
      return reply.send({ ok: true });
    },
  );
}
