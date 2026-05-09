import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@platform/db';
import {
  createHybridRetriever,
  extractCitedChunkIds,
  buildSafetyDirective,
  buildSystemPrompt,
  type SafetyFlaggedChunk,
} from '@platform/ai';
import { AIChatRequestSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';

export async function registerAIRoutes(app: FastifyInstance) {
  // Server-Sent Events stream of a grounded troubleshooter turn.
  //
  // Events:
  //   conversation  { conversationId }                     — emitted first
  //   delta         { text }                               — repeated for each token chunk
  //   done          { messageId, citations, usage }        — final
  //   error         { message }                            — fatal
  //
  // Uses reply.hijack() so Fastify leaves the socket alone and we write raw SSE.
  app.post('/ai/chat', { schema: { body: AIChatRequestSchema } }, async (request, reply) => {
    const { db, anthropic, env, storage } = app.ctx;
    const auth = requireAuth(request);
    const body = request.body as import('@platform/shared').AIChatRequest;

    // Resolve asset context first (so we can error cleanly before starting the stream).
    const instance = await db.query.assetInstances.findFirst({
      where: eq(schema.assetInstances.id, body.assetInstanceId),
      with: { model: true, site: true, pinnedContentPackVersion: true },
    });
    if (!instance) return reply.notFound('Asset instance not found.');
    // Scope guard: the asset's owning org must be in the caller's scope.
    // Otherwise a signed-in user could ask the troubleshooter about any
    // other org's asset and pull knowledge out of its content pack.
    const scope = await getScope(request, db);
    requireOrgInScope(scope, instance.site.organizationId);
    if (!instance.pinnedContentPackVersionId) {
      return reply.badRequest('Asset has no pinned ContentPack version — AI chat unavailable.');
    }

    // Get or create conversation.
    let conversation = body.conversationId
      ? await db.query.aiConversations.findFirst({
          where: and(
            eq(schema.aiConversations.id, body.conversationId),
            eq(schema.aiConversations.userId, auth.userId),
          ),
        })
      : undefined;
    if (!conversation) {
      const [created] = await db
        .insert(schema.aiConversations)
        .values({
          userId: auth.userId,
          assetInstanceId: instance.id,
          contentPackVersionId: instance.pinnedContentPackVersionId,
          title: null,
        })
        .returning();
      conversation = created;
    }
    if (!conversation) return reply.internalServerError('Failed to create conversation.');

    // History.
    const history = await db.query.aiMessages.findMany({
      where: eq(schema.aiMessages.conversationId, conversation.id),
    });
    history.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // If the user attached an image (photo of a fault code, nameplate, part),
    // ask the vision model to extract descriptive text first. We use that
    // extracted text as the retrieval query so the RAG pipeline can find
    // matching procedures. Photo-based fault diagnosis.
    let retrievalQuery = body.message ?? '';
    let imageDescription: string | null = null;
    if (body.imageStorageKey) {
      try {
        const stream = await storage.stream(body.imageStorageKey);
        if (stream) {
          const chunks: Buffer[] = [];
          for await (const c of stream.stream as unknown as AsyncIterable<Buffer>) chunks.push(c);
          const buf = Buffer.concat(chunks);
          const mime =
            body.imageStorageKey.toLowerCase().endsWith('.png')
              ? 'image/png'
              : body.imageStorageKey.toLowerCase().endsWith('.webp')
              ? 'image/webp'
              : 'image/jpeg';
          const descResp = await anthropic.messages.create({
            model: env.ANTHROPIC_MODEL,
            max_tokens: 400,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: mime, data: buf.toString('base64') },
                  },
                  {
                    type: 'text',
                    text: `You are looking at a photo taken by a technician at an industrial site. The equipment is: ${instance.model.displayName} (${instance.model.category}), serial ${instance.serialNumber}.

Extract in 2–3 sentences the key observable facts: any visible fault codes, alarm lights, error messages, nameplate identifiers, or the specific component visible. Do not speculate or advise — just describe what's in the frame. Begin: "Photo shows"`,
                  },
                ],
              },
            ],
          });
          imageDescription = descResp.content
            .filter((b): b is import('@anthropic-ai/sdk').Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim();
          if (imageDescription) {
            retrievalQuery = `${body.message} ${imageDescription}`.trim();
          }
        }
      } catch (err) {
        request.log.error({ err }, 'vision preprocessing failed; continuing without');
      }
    }

    // If partId is set, scope retrieval to documents author-linked to that
    // part. The PWA's part-detail Assistant tab passes this so answers cite
    // only the docs explicitly curated for the selected part. We compute the
    // document ID set here (small query) and hand it to the retriever, and
    // we also gather enough part metadata to tell the model which specific
    // part is in focus — otherwise it asks "which part?" despite the UI
    // being zoomed into one.
    let scopedDocumentIds: string[] | undefined;
    let partContext: {
      oemPartNumber: string;
      displayName: string;
      description: string | null;
      positionRef: string | null;
      parentPartDisplayName?: string | null;
      parentOemPartNumber?: string | null;
    } | null = null;

    if (body.partId) {
      const [part, bomRow, parentLink] = await Promise.all([
        db.query.parts.findFirst({
          where: eq(schema.parts.id, body.partId),
        }),
        db.query.bomEntries.findFirst({
          where: and(
            eq(schema.bomEntries.partId, body.partId),
            eq(schema.bomEntries.assetModelId, instance.model.id),
          ),
        }),
        db.query.partComponents.findFirst({
          where: eq(schema.partComponents.childPartId, body.partId),
        }),
      ]);

      if (part) {
        let parentPartDisplayName: string | null = null;
        let parentOemPartNumber: string | null = null;
        if (parentLink) {
          const parent = await db.query.parts.findFirst({
            where: eq(schema.parts.id, parentLink.parentPartId),
            columns: { oemPartNumber: true, displayName: true },
          });
          if (parent) {
            parentPartDisplayName = parent.displayName;
            parentOemPartNumber = parent.oemPartNumber;
          }
        }
        partContext = {
          oemPartNumber: part.oemPartNumber,
          displayName: part.displayName,
          description: part.description,
          positionRef: bomRow?.positionRef ?? null,
          parentPartDisplayName,
          parentOemPartNumber,
        };
      }

      const links = await db.query.partDocuments.findMany({
        where: eq(schema.partDocuments.partId, body.partId),
      });
      // Intersect with the pinned version — links may reference docs from
      // older versions; we only want this version's docs to be retrievable.
      if (links.length > 0) {
        const docIds = [...new Set(links.map((l) => l.documentId))];
        const docs = await db.query.documents.findMany({
          where: inArray(schema.documents.id, docIds),
          columns: { id: true, contentPackVersionId: true },
        });
        scopedDocumentIds = docs
          .filter((d) => d.contentPackVersionId === conversation.contentPackVersionId)
          .map((d) => d.id);
      } else {
        // Explicit empty set → retriever returns nothing, AI will say "no info".
        scopedDocumentIds = [];
      }
    }

    // Field captures live in their own content_pack (kind='field_captures')
    // separate from the OEM pinned version. The Documents tab fetches both
    // and merges; the chat retriever needs to do the same or it'll claim
    // "no procedure for X" the moment a tech asks about a procedure they
    // just authored from the field. Lookup is null when the model has no
    // field captures yet — schema guarantees at most one such pack per model.
    const fieldCapturesVersionId = await db
      .execute<{ version_id: string | null }>(
        sql`SELECT cpv.id AS version_id
            FROM content_packs cp
            JOIN content_pack_versions cpv ON cpv.content_pack_id = cp.id
            WHERE cp.kind = 'field_captures'
              AND cp.asset_model_id = ${instance.assetModelId}
            ORDER BY cpv.version_number DESC
            LIMIT 1`,
      )
      .then((rows) => (rows[0]?.version_id ?? null) as string | null);

    const versionIds: string[] = [conversation.contentPackVersionId];
    if (fieldCapturesVersionId) versionIds.push(fieldCapturesVersionId);

    // Retrieve + enrich with safety flags. Hybrid retrieval (FTS + pgvector)
    // with Voyage reranking — best-in-class recall for grounded Q&A. If
    // VOYAGE_API_KEY is missing or quota-exhausted, the retriever degrades
    // to FTS-only automatically rather than failing the turn.
    const retriever = createHybridRetriever({
      db,
      options: {
        topK: 12,
        candidatesPerLeg: 40,
        skipRerank: !process.env.VOYAGE_API_KEY,
      },
    });
    const retrieved = await retriever.retrieve({
      query: retrievalQuery,
      contentPackVersionIds: versionIds,
      topK: 12,
      documentIds: scopedDocumentIds,
    });
    const chunks: SafetyFlaggedChunk[] = await enrichSafety(db, retrieved);

    // Build system prompt.
    const safetyDirective = buildSafetyDirective(chunks);
    const systemText = buildSystemPrompt(
      {
        assetModelDisplayName: instance.model.displayName,
        assetModelCategory: instance.model.category,
        serialNumber: instance.serialNumber,
        siteName: instance.site.name,
        contentPackVersionLabel:
          instance.pinnedContentPackVersion?.versionLabel ?? null,
        chunks,
        part: partContext,
      },
      safetyDirective,
    );

    // Record the user's message now so it survives even if the stream fails later.
    // Image attachment is noted inline so the history is complete.
    const userContentForHistory = body.imageStorageKey
      ? `[photo attached]${imageDescription ? ` — ${imageDescription}` : ''}\n\n${body.message ?? ''}`.trim()
      : body.message ?? '';
    await db.insert(schema.aiMessages).values({
      conversationId: conversation.id,
      role: 'user',
      content: userContentForHistory,
      citations: [],
    });

    // Begin SSE response. @fastify/cors sets its headers via the normal reply
    // pipeline, which we bypass by hijacking — so echo them explicitly here.
    const origin = request.headers.origin;
    if (origin && (origin === env.PUBLIC_PWA_ORIGIN || origin === env.PUBLIC_ADMIN_ORIGIN)) {
      reply.raw.setHeader('access-control-allow-origin', origin);
      reply.raw.setHeader('access-control-allow-credentials', 'true');
      reply.raw.setHeader('vary', 'origin');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    reply.raw.flushHeaders?.();
    reply.hijack();

    const write = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    write('conversation', { conversationId: conversation.id });

    let accumulated = '';
    try {
      // Build the current user turn. Include the image if one was attached so
      // the model can ground its answer against both visual + retrieved text.
      let currentUserContent: import('@anthropic-ai/sdk').Anthropic.MessageParam['content'];
      if (body.imageStorageKey) {
        const s = await storage.stream(body.imageStorageKey);
        if (s) {
          const bufs: Buffer[] = [];
          for await (const c of s.stream as unknown as AsyncIterable<Buffer>) bufs.push(c);
          const buf = Buffer.concat(bufs);
          const mime =
            body.imageStorageKey.toLowerCase().endsWith('.png')
              ? 'image/png'
              : body.imageStorageKey.toLowerCase().endsWith('.webp')
              ? 'image/webp'
              : 'image/jpeg';
          currentUserContent = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mime,
                data: buf.toString('base64'),
              },
            },
            {
              type: 'text',
              text: (body.message ?? '').trim() ||
                'Look at this photo and explain what I should do next. Reference the retrieved procedures.',
            },
          ];
        } else {
          currentUserContent = body.message ?? '';
        }
      } else {
        currentUserContent = body.message ?? '';
      }

      const stream = anthropic.messages.stream({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: [
          { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          ...history.map((m) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: m.content,
          })),
          { role: 'user' as const, content: currentUserContent },
        ],
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          accumulated += event.delta.text;
          write('delta', { text: event.delta.text });
        }
      }

      const finalMsg = await stream.finalMessage();

      // Resolve citations from the accumulated text.
      const referencedChunkIds = extractCitedChunkIds(accumulated);
      const citedChunks = referencedChunkIds.length
        ? await db.query.documentChunks.findMany({
            where: inArray(schema.documentChunks.id, referencedChunkIds),
          })
        : [];
      const citedDocs = citedChunks.length
        ? await db.query.documents.findMany({
            where: inArray(
              schema.documents.id,
              [...new Set(citedChunks.map((c) => c.documentId))],
            ),
          })
        : [];
      const docById = new Map(citedDocs.map((d) => [d.id, d]));
      const citations = citedChunks.map((c) => ({
        chunkId: c.id,
        documentId: c.documentId,
        documentTitle: docById.get(c.documentId)?.title ?? 'Untitled',
        safetyCritical: docById.get(c.documentId)?.safetyCritical ?? false,
        contentPackVersionId: c.contentPackVersionId,
        quote: c.content.slice(0, 280),
        ...(c.charStart !== null ? { charStart: c.charStart } : {}),
        ...(c.charEnd !== null ? { charEnd: c.charEnd } : {}),
        ...(c.page !== null ? { page: c.page } : {}),
      }));

      const persistedCitations = citations.map(
        ({ documentId, contentPackVersionId, quote, charStart, charEnd, page }) => ({
          documentId,
          contentPackVersionId,
          quote,
          ...(charStart !== undefined ? { charStart } : {}),
          ...(charEnd !== undefined ? { charEnd } : {}),
          ...(page !== undefined ? { page } : {}),
        }),
      );

      const usage = {
        inputTokens: finalMsg.usage.input_tokens,
        cachedInputTokens: finalMsg.usage.cache_read_input_tokens ?? undefined,
        outputTokens: finalMsg.usage.output_tokens,
      };

      const [assistantMsg] = await db
        .insert(schema.aiMessages)
        .values({
          conversationId: conversation.id,
          role: 'assistant',
          content: accumulated,
          citations: persistedCitations,
          modelId: env.ANTHROPIC_MODEL,
          inputTokens: { total: usage.inputTokens, cached: usage.cachedInputTokens },
          outputTokens: { total: usage.outputTokens },
        })
        .returning();

      write('done', {
        messageId: assistantMsg?.id,
        citations,
        usage,
      });

      // Two-pass verifier. After the main answer is fully streamed, ask a
      // smaller model whether each sentence in the answer is actually
      // supported by the retrieved chunks. The result lets the PWA render
      // an evidence map (per-sentence support markers + per-source weights)
      // without paying that latency on the first byte. We let this fail
      // silently — the answer is already in front of the user, this is
      // additive trust UI.
      try {
        const verify = await runVerifier({
          anthropic,
          model: env.ANTHROPIC_VERIFIER_MODEL,
          answer: accumulated,
          chunks,
          citedChunkIds: referencedChunkIds,
        });
        if (verify) write('verify', verify);
      } catch (err) {
        request.log.warn({ err }, 'verifier pass failed; skipping');
      }
    } catch (err) {
      request.log.error({ err }, 'chat stream failed');
      write('error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      reply.raw.end();
    }
  });
}

async function enrichSafety(
  db: import('@platform/db').Database,
  chunks: Array<{
    id: string;
    documentId: string;
    contentPackVersionId: string;
    content: string;
    charStart: number | null;
    charEnd: number | null;
    page: number | null;
    score: number;
  }>,
): Promise<SafetyFlaggedChunk[]> {
  if (chunks.length === 0) return [];
  const docIds = [...new Set(chunks.map((c) => c.documentId))];
  const docs = await db.query.documents.findMany({
    where: inArray(schema.documents.id, docIds),
  });
  const safetyById = new Map(docs.map((d) => [d.id, d.safetyCritical]));
  return chunks.map((c) => ({ ...c, safetyCritical: safetyById.get(c.documentId) ?? false }));
}

// ---------------------------------------------------------------------------
// Two-pass verifier
// ---------------------------------------------------------------------------

interface VerifySentence {
  text: string;
  level: 'supported' | 'weak' | 'unsupported';
  chunkIds: string[];
}
interface VerifyResult {
  sentences: VerifySentence[];
  // Per-source weight (sum to 1.0) — how much each cited chunk contributed.
  sources: Array<{ chunkId: string; weight: number }>;
  // Plain-English description of any conflict between cited sources, or null.
  conflict: string | null;
}

async function runVerifier(input: {
  anthropic: import('@platform/ai').Anthropic;
  model: string;
  answer: string;
  chunks: SafetyFlaggedChunk[];
  citedChunkIds: string[];
}): Promise<VerifyResult | null> {
  const { anthropic, model, answer, chunks, citedChunkIds } = input;
  // Strip the [cite:UUID] markers — the verifier rates the prose, not the
  // markers. We hand the chunks separately as the truth set.
  const cleaned = answer.replace(/\[cite:[a-f0-9-]{8,}\]/gi, '').trim();
  if (cleaned.length === 0) return null;

  // Limit verifier context to chunks that were retrieved AND any chunks the
  // model cited (typically the same set; defense in depth in case the model
  // cited an out-of-band ID).
  const ids = new Set<string>([...chunks.map((c) => c.id), ...citedChunkIds]);
  const truthSet = chunks
    .filter((c) => ids.has(c.id))
    .slice(0, 12) // hard cap — keeps verifier prompt small + fast
    .map((c) => `[${c.id}]\n${c.content.slice(0, 800)}`)
    .join('\n\n---\n\n');
  if (!truthSet) return null;

  const systemText = `You are a strict grounding verifier. You receive an assistant's answer and a numbered set of source chunks. Classify EVERY sentence in the answer:
- "supported": the claim is directly stated or clearly implied by ≥1 source.
- "weak": the source is related but does not actually back the specific claim.
- "unsupported": no source backs the claim.

Also output per-source weights (how much each chunk contributed; weights sum to 1.0 across sources you actually used) and a one-line conflict description if any cited sources contradict each other (otherwise null).

Output ONLY a JSON object. No prose. No code fences. Schema:
{
  "sentences": [{ "text": string, "level": "supported"|"weak"|"unsupported", "chunkIds": string[] }],
  "sources": [{ "chunkId": string, "weight": number }],
  "conflict": string | null
}`;

  const userText = `SOURCES:\n\n${truthSet}\n\n---\n\nANSWER:\n\n${cleaned}\n\nReturn the JSON now.`;

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    system: systemText,
    messages: [{ role: 'user', content: userText }],
  });
  const text = resp.content
    .filter((b): b is import('@anthropic-ai/sdk').Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // The model occasionally wraps JSON in code fences despite the instruction.
  // Strip them defensively.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const sentences = Array.isArray(obj.sentences)
    ? (obj.sentences as Array<Record<string, unknown>>)
        .filter(
          (s) =>
            typeof s.text === 'string' &&
            (s.level === 'supported' || s.level === 'weak' || s.level === 'unsupported'),
        )
        .map((s) => ({
          text: s.text as string,
          level: s.level as VerifySentence['level'],
          chunkIds: Array.isArray(s.chunkIds)
            ? (s.chunkIds as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
        }))
    : [];

  const sources = Array.isArray(obj.sources)
    ? (obj.sources as Array<Record<string, unknown>>)
        .filter((s) => typeof s.chunkId === 'string' && typeof s.weight === 'number')
        .map((s) => ({ chunkId: s.chunkId as string, weight: s.weight as number }))
    : [];

  const conflict = typeof obj.conflict === 'string' ? obj.conflict : null;
  return { sentences, sources, conflict };
}
