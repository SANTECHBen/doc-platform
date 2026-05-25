// Voice-search + text-search routes for the PWA. Mirrors the
// /ai/voice/transcribe + retrieval split: the voice endpoint takes a
// multipart audio body, transcribes via Whisper, then runs the hybrid
// search and returns results + a TTS-ready spoken preview.
//
// Surface:
//   POST /ai/search        JSON { query, assetInstanceId?, topK? }
//   POST /ai/search/voice  multipart audio + form fields → search result
//
// Scope:
//   With an assetInstanceId, results are limited to that asset's pinned
//   content pack version + its overlay candidates (see
//   resolveSearchScopeForAssetInstance).
//   Without assetInstanceId, the request requires auth; results span the
//   caller's org-tree scope.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createSearchHybridRetriever,
  type SearchHit,
} from '@platform/ai';
import { schema, type Database, type SearchSourceType } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuthOrScan } from '../middleware/scan-session.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import {
  resolveSearchScopeForAssetInstance,
  resolveSearchScopeForUser,
  type SearchScope,
} from '../services/search-scope.js';
import { buildSearchJumpTarget } from '../services/search-jump-url.js';
import { buildSpokenPreview } from '../services/spoken-preview.js';
import {
  computeSttCostCents,
  enforceVoiceQuota,
  QuotaExceededError,
} from '../lib/voice-quota.js';

const SourceTypeSchema = z.enum([
  'doc_chunk',
  'procedure_step',
  'document_section',
]);

const SearchBodySchema = z.object({
  query: z.string().min(1).max(500),
  assetInstanceId: UuidSchema.optional(),
  topK: z.coerce.number().int().min(1).max(20).default(8),
  sourceTypes: z.array(SourceTypeSchema).min(1).max(3).optional(),
});

const VoiceFormSchema = z.object({
  assetInstanceId: z.string().uuid().optional(),
  topK: z.coerce.number().int().min(1).max(20).default(8),
});

function maybeReplyQuotaExceeded(err: unknown, reply: FastifyReply): boolean {
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

interface ResolvedSearchScope {
  scope: SearchScope;
  /** Org id used for quota debit. */
  orgIdForQuota: string;
  storedQuota: import('@platform/db').VoiceQuotaConfig | null;
}

async function resolveScope(
  request: FastifyRequest,
  db: Database,
  assetInstanceId: string | undefined,
): Promise<ResolvedSearchScope | { reply: { statusCode: number; message: string } }> {
  // Asset-scoped path (scan-session or auth both work — the scan-session
  // path is the common PWA flow).
  if (assetInstanceId) {
    const sessionAsset = request.scanSession?.assetInstanceId;
    if (sessionAsset && sessionAsset !== assetInstanceId) {
      return {
        reply: {
          statusCode: 403,
          message: 'scan session does not match assetInstanceId',
        },
      };
    }
    // Authenticated callers (no scan session) can still pass an
    // assetInstanceId — verify the asset's owning org is in the caller's
    // scope. Previously this branch was unchecked: a dealer-admin could
    // pass any UUID and receive RAG-retrieved snippets from a foreign
    // tenant's procedures and PDFs.
    if (request.auth && !sessionAsset) {
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, assetInstanceId),
        with: { site: { columns: { organizationId: true } } },
      });
      if (!instance) {
        // 404 not 403 — avoid existence oracle.
        return {
          reply: { statusCode: 404, message: 'Asset instance not found' },
        };
      }
      const scope = await getScope(request, db);
      try {
        requireOrgInScope(scope, instance.site.organizationId);
      } catch {
        return {
          reply: { statusCode: 404, message: 'Asset instance not found' },
        };
      }
    }
    const orgIdForQuota =
      request.auth?.organizationId ?? request.scanSession?.organizationId;
    if (!orgIdForQuota) {
      return {
        reply: { statusCode: 401, message: 'auth or scan session required' },
      };
    }
    const scope = await resolveSearchScopeForAssetInstance(db, assetInstanceId);
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, orgIdForQuota),
      columns: { voiceQuota: true },
    });
    return {
      scope,
      orgIdForQuota,
      storedQuota: org?.voiceQuota ?? null,
    };
  }
  // No asset context: require auth, use the user's org tree.
  if (!request.auth) {
    return {
      reply: { statusCode: 401, message: 'auth required without assetInstanceId' },
    };
  }
  const scope = await resolveSearchScopeForUser(db, await getScope(request, db));
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, request.auth.organizationId),
    columns: { voiceQuota: true },
  });
  return {
    scope,
    orgIdForQuota: request.auth.organizationId,
    storedQuota: org?.voiceQuota ?? null,
  };
}

function shapeResults(hits: SearchHit[]) {
  return hits.map((h) => {
    // Trim long content client-side — the rerank used the full text, but
    // the bottom-sheet card only renders a snippet. Keeps payloads small.
    const snippet = h.content.length > 240 ? h.content.slice(0, 240) + '…' : h.content;
    const sectionTitle =
      typeof h.metadata.sectionTitle === 'string' ? h.metadata.sectionTitle : null;
    const docTitle =
      typeof h.metadata.docTitle === 'string' ? h.metadata.docTitle : null;
    return {
      id: h.id,
      sourceType: h.sourceType,
      sourceId: h.sourceId,
      documentId: h.documentId,
      contentPackVersionId: h.contentPackVersionId,
      title: h.title,
      snippet,
      score: h.score,
      docTitle,
      sectionTitle,
      jumpTarget: buildSearchJumpTarget(h),
    };
  });
}

export async function registerSearchRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // POST /ai/search — JSON text search
  // -------------------------------------------------------------------------
  app.post<{ Body: z.infer<typeof SearchBodySchema> }>(
    '/ai/search',
    { schema: { body: SearchBodySchema } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuthOrScan(request);

      const resolved = await resolveScope(
        request,
        db,
        request.body.assetInstanceId,
      );
      if ('reply' in resolved) {
        return reply.code(resolved.reply.statusCode).send({
          statusCode: resolved.reply.statusCode,
          error: resolved.reply.statusCode === 401 ? 'Unauthorized' : 'Forbidden',
          message: resolved.reply.message,
        });
      }
      const { scope } = resolved;

      if (
        scope.contentPackVersionIds.length === 0 ||
        scope.ownerOrganizationIds.length === 0
      ) {
        return reply.send({ results: [] });
      }

      const retriever = createSearchHybridRetriever({
        db,
        options: { topK: request.body.topK },
      });
      const hits = await retriever.retrieve({
        query: request.body.query,
        contentPackVersionIds: scope.contentPackVersionIds,
        ownerOrganizationIds: scope.ownerOrganizationIds,
        topK: request.body.topK,
        sourceTypes: request.body.sourceTypes as SearchSourceType[] | undefined,
      });
      return reply.send({ results: shapeResults(hits) });
    },
  );

  // -------------------------------------------------------------------------
  // POST /ai/search/voice — multipart audio body
  //
  // Form fields:
  //   audio              : the recorded utterance (webm/opus, mp3, m4a, wav)
  //   assetInstanceId?   : narrows scope (PWA scan context)
  //   topK?              : default 8
  // Returns:
  //   { transcript, results, spokenPreview: { text, confidence } }
  // -------------------------------------------------------------------------
  app.post('/ai/search/voice', async (request, reply) => {
    const { env, db } = app.ctx;
    requireAuthOrScan(request);
    if (!env.OPENAI_API_KEY) {
      return reply
        .code(503)
        .send({ error: 'Voice transcription is not configured (OPENAI_API_KEY).' });
    }
    if (!request.isMultipart()) {
      return reply.badRequest('Expected multipart/form-data.');
    }

    // Collect multipart fields. fastify-multipart's parts iterator gives us
    // both file and value fields in one stream.
    let audioFile: Awaited<ReturnType<typeof request.file>> | null = null;
    const fields: Record<string, string> = {};
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'audio') {
          audioFile = part;
          // Drain the file buffer in the next block once we have other fields;
          // exit the iterator here would lose subsequent text parts because
          // we've already consumed them above the file. Multipart parts
          // iterate in body order, so we capture the file ref now and read
          // bytes below.
          break;
        }
      } else if (part.type === 'field') {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!audioFile) {
      return reply.badRequest('Missing "audio" file field.');
    }

    // Validate form fields up front so we don't waste Whisper cost on a
    // bad scope.
    const parsedFields = VoiceFormSchema.safeParse(fields);
    if (!parsedFields.success) {
      return reply.badRequest(parsedFields.error.message);
    }

    const resolved = await resolveScope(
      request,
      db,
      parsedFields.data.assetInstanceId,
    );
    if ('reply' in resolved) {
      return reply.code(resolved.reply.statusCode).send({
        statusCode: resolved.reply.statusCode,
        error: resolved.reply.statusCode === 401 ? 'Unauthorized' : 'Forbidden',
        message: resolved.reply.message,
      });
    }
    const { scope, orgIdForQuota, storedQuota } = resolved;

    // Pre-flight quota check — daily turns + monthly $ ceiling. Whisper
    // duration isn't known yet; we debit after the call.
    try {
      await enforceVoiceQuota(db, orgIdForQuota, storedQuota, 'stt');
    } catch (err) {
      if (maybeReplyQuotaExceeded(err, reply)) return;
      throw err;
    }

    // Drain audio bytes. Max 25 MB matches Whisper's hard limit.
    const chunks: Buffer[] = [];
    for await (const c of audioFile.file as unknown as AsyncIterable<Buffer>) {
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (buf.byteLength === 0) return reply.badRequest('Empty audio.');
    if (buf.byteLength > 25 * 1024 * 1024) {
      return reply.payloadTooLarge('Audio exceeds 25 MB.');
    }

    // Whisper STT.
    const form = new FormData();
    const blob = new Blob([buf], { type: audioFile.mimetype || 'audio/webm' });
    form.append('file', blob, audioFile.filename || 'query.webm');
    form.append('model', env.OPENAI_STT_MODEL);
    form.append('response_format', 'verbose_json');
    form.append(
      'prompt',
      'Industrial maintenance technician asking about equipment, parts, procedures.',
    );
    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      request.log.error({ status: upstream.status, text }, 'voice search STT failed');
      return reply.internalServerError('Transcription failed.');
    }
    const json = (await upstream.json()) as { text?: string; duration?: number };
    const transcript = (json.text ?? '').trim();
    const seconds = Math.max(1, Math.ceil(json.duration ?? 0));

    // STT debit — best-effort, parallel to the response. See voice.ts for
    // the same pattern.
    void (async () => {
      try {
        await import('../lib/voice-quota.js').then(async ({ recordVoiceUsage }) =>
          recordVoiceUsage(db, {
            organizationId: orgIdForQuota,
            kind: 'stt',
            units: seconds,
            costCents: computeSttCostCents(seconds),
            userId: request.auth?.userId ?? null,
            assetInstanceId: request.scanSession?.assetInstanceId ?? null,
          }),
        );
      } catch (err) {
        request.log.warn({ err }, 'voice-search: STT debit failed');
      }
    })();

    if (!transcript) {
      return reply.send({
        transcript: '',
        results: [],
        spokenPreview: {
          text: "I didn't catch that. Try speaking a bit longer.",
          confidence: 'none' as const,
        },
      });
    }
    if (
      scope.contentPackVersionIds.length === 0 ||
      scope.ownerOrganizationIds.length === 0
    ) {
      return reply.send({
        transcript,
        results: [],
        spokenPreview: {
          text: 'I could not find a match for that. Try rephrasing.',
          confidence: 'none' as const,
        },
      });
    }

    const retriever = createSearchHybridRetriever({
      db,
      options: { topK: parsedFields.data.topK },
    });
    const hits = await retriever.retrieve({
      query: transcript,
      contentPackVersionIds: scope.contentPackVersionIds,
      ownerOrganizationIds: scope.ownerOrganizationIds,
      topK: parsedFields.data.topK,
    });

    const preview = buildSpokenPreview({ transcript, hits });
    return reply.send({
      transcript,
      results: shapeResults(hits),
      spokenPreview: preview,
    });
  });
}
