import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
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

    // Retrieve + enrich with safety flags. Hybrid retrieval (FTS + pgvector)
    // with Voyage reranking — best-in-class recall for grounded Q&A. If
    // VOYAGE_API_KEY is missing or quota-exhausted, the retriever degrades
    // to FTS-only automatically rather than failing the turn.
    const retriever = createHybridRetriever({
      db,
      options: {
        topK: 8,
        candidatesPerLeg: 30,
        skipRerank: !process.env.VOYAGE_API_KEY,
      },
    });
    const retrieved = await retriever.retrieve({
      query: retrievalQuery,
      contentPackVersionIds: [conversation.contentPackVersionId],
      topK: 8,
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
