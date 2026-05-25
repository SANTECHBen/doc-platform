// Admin authoring API for per-snippet voiceover audio.
//
// Mirrors admin-procedure-audio.ts. Same upload / generate / delete trio
// but writes to procedure_snippets.audio_* columns. The PWA runner falls
// back to the snippet's audio when a snippet-attached step has no audio
// of its own — so editing a single snippet's voiceover propagates across
// every procedure that references it.
//
//   POST   /admin/snippets/:id/audio              upload MP3/M4A
//   POST   /admin/snippets/:id/audio/generate     synthesize via OpenAI TTS
//   PATCH  /admin/snippets/:id/audio/duration     client-probed duration
//   DELETE /admin/snippets/:id/audio              clear

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database, type StepBlock } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope, type Scope } from '../middleware/scope.js';
import { synthesizeStepTts } from '../services/step-tts.js';
import { sniffMime } from '../lib/mime-sniff.js';

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
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_GEN_VOICE_FALLBACK = 'onyx';

interface SnippetCtx {
  snippet: typeof schema.procedureSnippets.$inferSelect;
  /** Where the audit event lands. For platform snippets we attribute to
   *  the editor's home org (audit_events.organization_id is NOT NULL). */
  auditOrgId: string;
}

async function loadSnippetForWrite(
  db: Database,
  snippetId: string,
  scope: Scope,
  auth: { organizationId: string; platformAdmin?: boolean },
): Promise<SnippetCtx | null> {
  const snippet = await db.query.procedureSnippets.findFirst({
    where: eq(schema.procedureSnippets.id, snippetId),
  });
  if (!snippet) return null;
  if (snippet.isPlatform) {
    if (!auth.platformAdmin) {
      const err = new Error('Platform snippets can only be edited by platform admins') as Error & {
        statusCode: number;
      };
      err.statusCode = 403;
      throw err;
    }
    return { snippet, auditOrgId: auth.organizationId };
  }
  if (!snippet.ownerOrganizationId) {
    return null;
  }
  requireOrgInScope(scope, snippet.ownerOrganizationId);
  return { snippet, auditOrgId: snippet.ownerOrganizationId };
}

/** Build a clean script from the snippet's title + flattened block text.
 *  Mirrors the procedure-step variant; markdown noise is stripped so the
 *  TTS doesn't read symbols. */
function buildSnippetScript(snippet: typeof schema.procedureSnippets.$inferSelect): string {
  const lead = (snippet.title ?? '').trim();
  const bodyParts: string[] = [];
  for (const b of (snippet.blocks ?? []) as StepBlock[]) {
    switch (b.kind) {
      case 'paragraph':
        bodyParts.push(b.text);
        break;
      case 'callout':
        bodyParts.push(`${b.title ? b.title + '. ' : ''}${b.text}`);
        break;
      case 'bullet_list':
      case 'numbered_list':
        bodyParts.push(b.items.join('. '));
        break;
      case 'key_value':
        bodyParts.push(
          b.rows.map((row: [string, string]) => `${row[0]}: ${row[1]}`).join('. '),
        );
        break;
      case 'photo_inline':
        if (b.caption) bodyParts.push(b.caption);
        break;
    }
  }
  const body = bodyParts.join(' ').replace(/\s+/g, ' ').trim();
  return body ? `${lead}. ${body}` : lead;
}

const GenerateBody = z.object({
  voice: z
    .enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'])
    .optional(),
  script: z.string().min(2).max(4000).optional(),
});

const DurationBody = z.object({
  audioDurationMs: z.number().int().min(0).max(60 * 60 * 1000),
});

export async function registerAdminSnippetAudioRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /admin/snippets/:id/audio (multipart upload)
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/snippets/:id/audio',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSnippetForWrite(db, request.params.id, scope, auth);
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
      // Magic-byte check — refuse anything that doesn't match an audio format.
      const sniffed = sniffMime(buf);
      const SAFE_AUDIO = new Set([
        'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm',
      ]);
      if (!sniffed || !SAFE_AUDIO.has(sniffed)) {
        return reply.unsupportedMediaType('File content does not match a supported audio format.');
      }
      const verifiedMime = sniffed;
      const stored = await storage.putBuffer({
        buffer: buf,
        filename: file.filename || `snippet-${ctx.snippet.id}.audio`,
        contentType: verifiedMime,
        ownerOrganizationId: ctx.auditOrgId,
      });

      const [updated] = await db
        .update(schema.procedureSnippets)
        .set({
          audioStorageKey: stored.storageKey,
          audioContentType: verifiedMime,
          audioSizeBytes: stored.size,
          audioDurationMs: null,
          audioSource: 'uploaded',
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSnippets.id, ctx.snippet.id))
        .returning();

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.auditOrgId,
        actorUserId: auth.userId,
        eventType: 'procedure_snippet.audio_uploaded',
        targetType: 'procedure_snippet',
        targetId: ctx.snippet.id,
        payload: { mime, sizeBytes: stored.size, isPlatform: ctx.snippet.isPlatform },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
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
  // POST /admin/snippets/:id/audio/generate
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: z.infer<typeof GenerateBody> }>(
    '/admin/snippets/:id/audio/generate',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: GenerateBody,
      },
    },
    async (request, reply) => {
      const { db, storage, env } = app.ctx;
      if (!env.OPENAI_API_KEY) {
        return reply.code(503).send({
          error: 'Audio generation requires OPENAI_API_KEY.',
        });
      }
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSnippetForWrite(db, request.params.id, scope, auth);
      if (!ctx) return reply.notFound();

      const script = request.body.script ?? buildSnippetScript(ctx.snippet);
      const voice = request.body.voice ?? env.OPENAI_TTS_VOICE ?? AUDIO_GEN_VOICE_FALLBACK;
      const synth = await synthesizeStepTts({
        text: script,
        voice,
        model: env.OPENAI_TTS_MODEL,
        openaiApiKey: env.OPENAI_API_KEY,
        storage,
        filenameStem: `snippet-${ctx.snippet.id}-tts`,
        ownerOrganizationId: ctx.auditOrgId,
      });

      const [updated] = await db
        .update(schema.procedureSnippets)
        .set({
          audioStorageKey: synth.storageKey,
          audioContentType: synth.contentType,
          audioSizeBytes: synth.sizeBytes,
          audioDurationMs: null,
          audioSource: 'generated',
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSnippets.id, ctx.snippet.id))
        .returning();

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.auditOrgId,
        actorUserId: auth.userId,
        eventType: 'procedure_snippet.audio_generated',
        targetType: 'procedure_snippet',
        targetId: ctx.snippet.id,
        payload: {
          voice,
          scriptChars: script.length,
          sizeBytes: synth.sizeBytes,
          isPlatform: ctx.snippet.isPlatform,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send({
        audioUrl: storage.publicUrl(synth.storageKey),
        audioContentType: synth.contentType,
        audioSizeBytes: synth.sizeBytes,
        audioSource: 'generated' as const,
        voice,
        updatedAt: updated?.updatedAt.toISOString(),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/snippets/:id/audio/duration — client probe update
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: z.infer<typeof DurationBody> }>(
    '/admin/snippets/:id/audio/duration',
    {
      schema: { params: z.object({ id: UuidSchema }), body: DurationBody },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSnippetForWrite(db, request.params.id, scope, auth);
      if (!ctx) return reply.notFound();
      if (!ctx.snippet.audioStorageKey) {
        return reply.badRequest('snippet has no audio to set duration on');
      }
      await db
        .update(schema.procedureSnippets)
        .set({
          audioDurationMs: request.body.audioDurationMs,
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSnippets.id, ctx.snippet.id));
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/snippets/:id/audio — clear voiceover
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/admin/snippets/:id/audio',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSnippetForWrite(db, request.params.id, scope, auth);
      if (!ctx) return reply.notFound();
      await db
        .update(schema.procedureSnippets)
        .set({
          audioStorageKey: null,
          audioContentType: null,
          audioSizeBytes: null,
          audioDurationMs: null,
          audioSource: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.procedureSnippets.id, ctx.snippet.id));
      await db.insert(schema.auditEvents).values({
        organizationId: ctx.auditOrgId,
        actorUserId: auth.userId,
        eventType: 'procedure_snippet.audio_removed',
        targetType: 'procedure_snippet',
        targetId: ctx.snippet.id,
        payload: { isPlatform: ctx.snippet.isPlatform },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true });
    },
  );
}
