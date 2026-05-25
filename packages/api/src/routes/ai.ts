import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { PM_PLAN_FREQUENCY_LABEL } from '@platform/db';
import {
  createHybridRetriever,
  extractCitedChunkIds,
  buildSafetyDirective,
  buildSystemPrompt,
  buildRetrievedSourcesBlock,
  type SafetyFlaggedChunk,
} from '@platform/ai';
import { AIChatRequestSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';
import {
  computeVerifyCostCents,
  getUsageSnapshot,
  maybeFireSpendAlarm,
  recordVoiceUsage,
  resolveQuota,
} from '../lib/voice-quota';
import { sniffMime } from '../lib/mime-sniff';

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
      // Cross-tenant image-read defense. The key must correspond to a
      // recent upload by *this* user (or by a SANTECH platform-admin) and
      // not yet be consumed/expired. Without this check, any authenticated
      // caller could pass a guessed/leaked storage key belonging to
      // another tenant and have Claude vision describe the bytes. Returns
      // notFound (not forbidden) to avoid functioning as an existence
      // oracle for storage keys.
      const grant = await db.query.chatImageUploads.findFirst({
        where: and(
          eq(schema.chatImageUploads.storageKey, body.imageStorageKey),
          eq(schema.chatImageUploads.userId, auth.userId),
        ),
      });
      const now = new Date();
      if (
        !grant ||
        grant.consumedAt !== null ||
        grant.expiresAt.getTime() < now.getTime() ||
        // Belt-and-suspenders: the upload's org must also be in the
        // caller's scope. Prevents a stale grant from being reused if the
        // user has since left the org.
        grant.organizationId !== auth.organizationId
      ) {
        return reply.notFound('Image upload not found or expired.');
      }
      // Mark the grant consumed so a single uploaded image can't be
      // replayed across many vision calls (token-cost containment).
      await db
        .update(schema.chatImageUploads)
        .set({ consumedAt: now })
        .where(eq(schema.chatImageUploads.id, grant.id));
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

Extract in 2–4 sentences the key observable facts. Cover, in order:
1. The component visible (motor, sensor, actuator, belt, sprocket, bearing, valve, etc.) — be specific about what kind of part it is and its general role.
2. Any visible nameplate text, OEM part numbers, model identifiers, or labels — quote them verbatim if legible.
3. Any visible fault indicators — alarm LEDs, indicator lights, error codes, scorch marks, leaks, wear, broken pieces, missing fasteners.
4. The overall condition (clean / dusty / oily / damaged / appears normal).

Do not speculate about CAUSE or RECOMMEND action — just describe what's in the frame. The downstream answer pipeline will match this description against the equipment's parts catalog and authored troubleshooting guides. Begin: "Photo shows"`,
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
    // Defense-in-depth tenant scope for retrieval. The chat is already
    // bound to the asset's pinned content pack (versionIds), but we also
    // pass the asset's owning org as a hard WHERE filter on the chunks
    // table. A bug in versionId derivation can no longer leak across
    // tenants because both filters must agree.
    const retrievalOwnerOrgIds = [instance.site.organizationId];
    const retrieved = await retriever.retrieve({
      query: retrievalQuery,
      contentPackVersionIds: versionIds,
      topK: 12,
      documentIds: scopedDocumentIds,
      ownerOrganizationIds: retrievalOwnerOrgIds,
    });
    const chunks: SafetyFlaggedChunk[] = await enrichSafety(db, retrieved);

    // Available procedure catalog. We pull every authored
    // structured_procedure document for the asset's pinned version (and
    // field captures, if any), filtered to the part scope when set, and
    // inject titles + summaries into the system prompt so the model can
    // emit a [procedure:UUID] directive to launch a guided full-screen
    // walkthrough on the PWA.
    //
    // Why this design rather than Anthropic tool-use: this keeps the
    // streaming flow single-pass. The directive convention also makes
    // the AI's intent legible in transcript history (we don't have to
    // reconstruct tool calls from the message log).
    const procedureCatalogRows = await db.query.documents.findMany({
      where: and(
        inArray(schema.documents.contentPackVersionId, versionIds),
        eq(schema.documents.kind, 'structured_procedure'),
        // Honor the ai_indexed kill switch — a procedure explicitly opted
        // out of AI knowledge shouldn't show up as a [procedure:UUID]
        // directive either. Defaults are kind-aware (procedures start
        // true), so this mostly matters when an admin has deliberately
        // disabled a stale or draft procedure.
        eq(schema.documents.aiIndexed, true),
      ),
      columns: { id: true, title: true, bodyMarkdown: true },
      limit: 80,
    });
    // If part-scoped, restrict to procedures whose docs are author-linked
    // to the part. Reuses the same scopedDocumentIds the retriever did.
    const visibleProcedures =
      scopedDocumentIds === undefined
        ? procedureCatalogRows
        : procedureCatalogRows.filter((p) => scopedDocumentIds!.includes(p.id));

    // Pull the step titles for each visible procedure so the AI's
    // matching has rich semantic signal even when bodyMarkdown is null
    // (which it always is on procedures authored via the new CMS — content
    // lives in step rows, not the doc body). Cap at 8 step titles per
    // procedure to keep the system prompt bounded.
    const procedureStepHints = new Map<string, string>();
    if (visibleProcedures.length > 0) {
      const allSteps = await db.query.procedureSteps.findMany({
        where: inArray(
          schema.procedureSteps.documentId,
          visibleProcedures.map((p) => p.id),
        ),
        columns: {
          documentId: true,
          title: true,
          orderingHint: true,
          snippetId: true,
          snippetDetached: true,
        },
      });
      // Resolve attached snippets so the AI matcher sees the snippet's
      // title for any snippet-backed step whose own title is empty.
      const stepSnippetMap = await (async () => {
        const ids = allSteps
          .map((s) => s.snippetId)
          .filter((id): id is string => !!id && id.length > 0);
        if (ids.length === 0) return new Map<string, string>();
        const rows = await db.query.procedureSnippets.findMany({
          where: inArray(schema.procedureSnippets.id, [...new Set(ids)]),
          columns: { id: true, title: true },
        });
        return new Map(rows.map((r) => [r.id, r.title]));
      })();
      // Group by docId, sort by ordering, keep first 8 titles per doc.
      const byDoc = new Map<string, Array<{ title: string; orderingHint: number }>>();
      for (const s of allSteps) {
        const arr = byDoc.get(s.documentId) ?? [];
        // Attached snippet wins when the step has no own title.
        const effectiveTitle =
          s.snippetId && !s.snippetDetached && (!s.title || s.title.length === 0)
            ? stepSnippetMap.get(s.snippetId) ?? s.title
            : s.title;
        arr.push({ title: effectiveTitle, orderingHint: s.orderingHint });
        byDoc.set(s.documentId, arr);
      }
      for (const [docId, steps] of byDoc.entries()) {
        steps.sort((a, b) => a.orderingHint - b.orderingHint);
        const titles = steps
          .slice(0, 8)
          .map((s) => s.title.trim())
          .filter((t) => t.length > 0);
        if (titles.length > 0) {
          procedureStepHints.set(
            docId,
            titles.map((t, i) => `${i + 1}. ${t}`).join('; '),
          );
        }
      }
    }

    // Authored procedures only — the AI does NOT improvise step lists.
    // The business model is curated documentation; AI-generated steps
    // from PDFs would commoditize the product. When no authored
    // procedure matches, we want grounded prose with citations, and the
    // admin can promote a great answer into a proper authored procedure
    // via /admin/procedures/from-ai-message.
    const authoredProcedureCatalog = visibleProcedures.length
      ? `\n\nAVAILABLE STEP-BY-STEP PROCEDURES (authored, hands-free runner):
${visibleProcedures
  .slice(0, 30)
  .map((p) => {
    const stepHint = procedureStepHints.get(p.id);
    const bodyHint = p.bodyMarkdown
      ? p.bodyMarkdown.replace(/\s+/g, ' ').slice(0, 140)
      : null;
    const hint = stepHint ?? bodyHint ?? '(no content yet)';
    return `- [${p.id}] ${p.title || '(untitled)'} — ${hint}`;
  })
  .join('\n')}

If the user is asking HOW to perform a task and one of these procedures plausibly covers that task — match by intent, not by exact title; the procedure's step titles describe what it does — reply with ONLY this and nothing else (no prose, no preamble, no citations):
[procedure:THE_UUID]

Do not be overly strict: if a procedure for "Replace divert actuator" exists and the tech asks "How do I swap out the actuator on the divert switch?", that is a match — open it.

If no authored procedure plausibly matches, do NOT improvise a step list. Answer with normal grounded prose and [cite:…] markers; the admin can promote useful answers to authored procedures separately.`
      : `\n\nNo authored procedures are available for this asset yet. Answer with grounded prose and [cite:…] markers — do NOT improvise step-by-step lists.`;

    const stepsDirective = '';

    // Structured knowledge — PM plans + PM schedules + troubleshooting
    // guides for this asset model. These tables aren't part of the
    // document_chunks RAG corpus (no embeddings pipeline) so without
    // explicit injection the AI is blind to them. They're small enough
    // to inline in the system prompt and scoped per-model, so we just
    // fetch + format on every request. If/when these get large we'd
    // move to summaries or fold them into the embeddings pipeline.
    const structuredKnowledgeBlock = await buildStructuredKnowledgeBlock(
      db,
      instance.model.id,
    );

    // Live instance-state snapshot — what's overdue right now, what was
    // performed recently, what work orders are open on THIS asset. The
    // structured-knowledge block above is per-model (same for every
    // instance of the same machine); this block is per-instance and is
    // what lets the AI answer "when was the last belt inspection on
    // this unit?" or "is anything overdue?" without the user
    // describing the state to it first.
    const liveAssetStateBlock = await buildLiveAssetStateBlock(
      db,
      instance.id,
    );

    // Build system prompt.
    const safetyDirective = buildSafetyDirective(chunks);
    const systemText =
      buildSystemPrompt(
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
      ) +
      authoredProcedureCatalog +
      structuredKnowledgeBlock +
      liveAssetStateBlock +
      stepsDirective;

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

      // Voice mode uses the faster (Haiku) model — techs speaking under a
      // chiller need quick lookups, not the long-form depth Sonnet adds.
      // Text chat falls through to the default Sonnet model.
      const chatModel =
        body.mode === 'voice' ? env.ANTHROPIC_VOICE_MODEL : env.ANTHROPIC_MODEL;

      // Build the retrieved-sources block as a separate user-role message
      // so the (untrusted) chunk text never sits in the high-trust system
      // role. Chunk content is also sanitized inside buildRetrievedSourcesBlock
      // so wrapper-closing tokens and role headers can't escape the
      // envelope. See C-AI-3 in the security audit.
      const retrievedSourcesBlock = buildRetrievedSourcesBlock(chunks);

      const stream = anthropic.messages.stream({
        model: chatModel,
        max_tokens: 1024,
        system: [
          { type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          ...history.map((m) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: m.content,
          })),
          // Untrusted retrieved-sources block first, then the user's actual
          // question. Putting the sources earlier in the message stream
          // keeps them in cache as the conversation grows. (cache_control
          // is currently only set on the system block above; ephemeral
          // caching on user-role content is SDK-version-gated.)
          {
            role: 'user' as const,
            content: retrievedSourcesBlock,
          },
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

      // Resolve citations from the accumulated text. Restrict to the set of
      // chunk IDs that were actually retrieved this turn — a prompt-injected
      // PDF that emitted a foreign UUID can't surface another tenant's
      // chunk via the [cite:UUID] regex. See M-AI-2 in the security audit.
      const retrievedIdSet = new Set(retrieved.map((r) => r.id));
      const referencedChunkIds = extractCitedChunkIds(accumulated).filter(
        (id) => retrievedIdSet.has(id),
      );
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

      // Persist citations. We restrict `referencedChunkIds` above to the
      // retrieved set, so the persisted quote is always for a chunk the
      // caller was authorized to see this turn — closes the historical-
      // leak path even though we still write the quote text. See H-AI-4.
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

      // -----------------------------------------------------------------
      // Section directive resolution.
      //
      // Two cases attach a [section:UUID] directive to the response:
      //   1. The response is prose (no procedure directive) — the PWA
      //      shows the cited PDF section as a hands-free visual while
      //      TTS narrates the prose.
      //   2. The response is [procedure:UUID] but the UUID isn't in the
      //      catalog (Haiku hallucination). Falling through to a section
      //      gives the tech a useful answer instead of a 404.
      //
      // Resolution: for each cited chunk, find sections in the same
      // document whose page_range covers the chunk's page. Score by chunk
      // count; highest wins. Only page_range sections for v1 — text_range
      // anchor-matching is a future enhancement.
      // -----------------------------------------------------------------
      const procMatch = /^\s*\[procedure:([0-9a-f-]+)\]\s*$/i.exec(accumulated);
      const procedureUuidValid =
        procMatch != null &&
        visibleProcedures.some((p) => p.id === procMatch[1]!.toLowerCase());

      let sectionDirective: string | null = null;
      if (!procedureUuidValid && citedChunks.length > 0) {
        const docIds = [...new Set(citedChunks.map((c) => c.documentId))];
        const sectionRows = await db.query.documentSections.findMany({
          where: and(
            inArray(schema.documentSections.documentId, docIds),
            eq(schema.documentSections.needsRevalidation, false),
          ),
        });
        const sectionScore = new Map<string, number>();
        for (const ch of citedChunks) {
          if (ch.page === null) continue;
          const docSections = sectionRows.filter(
            (s) => s.documentId === ch.documentId,
          );
          for (const sec of docSections) {
            if (
              sec.kind === 'page_range' &&
              sec.pageStart !== null &&
              sec.pageEnd !== null &&
              ch.page >= sec.pageStart &&
              ch.page <= sec.pageEnd
            ) {
              sectionScore.set(sec.id, (sectionScore.get(sec.id) ?? 0) + 1);
            }
          }
        }
        if (sectionScore.size > 0) {
          const winner = [...sectionScore.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0]![0];
          sectionDirective = `[section:${winner}]`;
        }
      }
      // Synthetic fallback: when no authored section overlaps the citations,
      // derive a page range directly from the cited chunks (each chunk
      // already knows what page it came from). Lets the visual fallback work
      // even if the admin hasn't authored documentSections rows on the PDF.
      let pdfPageDirective: string | null = null;
      if (
        !sectionDirective &&
        !procedureUuidValid &&
        citedChunks.length > 0
      ) {
        const pagesByDoc = new Map<string, number[]>();
        for (const c of citedChunks) {
          if (c.page === null) continue;
          const arr = pagesByDoc.get(c.documentId) ?? [];
          arr.push(c.page);
          pagesByDoc.set(c.documentId, arr);
        }
        if (pagesByDoc.size > 0) {
          const top = [...pagesByDoc.entries()].sort(
            (a, b) => b[1].length - a[1].length,
          )[0]!;
          const [docId, pages] = top;
          const pageStart = Math.min(...pages);
          const pageEnd = Math.max(...pages);
          pdfPageDirective = `[pdfpage:${docId}:${pageStart}:${pageEnd}]`;
        }
      }

      const fallbackDirective = sectionDirective ?? pdfPageDirective;
      if (fallbackDirective) {
        // If the original was a bad procedure UUID, prepend a separator so
        // both directives are present in the accumulated stream. The PWA
        // gives precedence to section/pdfpage over procedure, so this turns
        // a 404 into a working visual answer.
        const append = procMatch ? `\n${fallbackDirective}` : ` ${fallbackDirective}`;
        accumulated += append;
        write('delta', { text: append });
      }

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
          modelId: chatModel,
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
      // supported by the retrieved chunks. Skipped for directive
      // responses ([procedure:UUID] or [steps]…[/steps]) — there's no
      // prose to verify and the verifier would just spend ~2s shrugging.
      const isDirective = /^\s*\[procedure:[0-9a-f-]+\]\s*$/i.test(accumulated);
      if (isDirective) {
        // No verifier work — close out cleanly so the PWA stops the
        // "thinking" indicator immediately.
      } else
      try {
        const verify = await runVerifier({
          anthropic,
          model: env.ANTHROPIC_VERIFIER_MODEL,
          answer: accumulated,
          chunks,
          citedChunkIds: referencedChunkIds,
        });
        if (verify) {
          write('verify', verify.result);
          // Charge the verifier call against the org's voice budget so the
          // chat-driven cost is visible alongside STT/TTS. Detached so a
          // ledger hiccup never breaks the chat turn the user already saw.
          void (async () => {
            try {
              const totalTokens = verify.inputTokens + verify.outputTokens;
              await recordVoiceUsage(db, {
                organizationId: instance.site.organizationId,
                userId: auth.userId,
                assetInstanceId: instance.id,
                kind: 'verify',
                units: totalTokens,
                costCents: computeVerifyCostCents({
                  inputTokens: verify.inputTokens,
                  outputTokens: verify.outputTokens,
                }),
              });
              const org = await db.query.organizations.findFirst({
                where: eq(schema.organizations.id, instance.site.organizationId),
                columns: { id: true, name: true, voiceQuota: true },
              });
              if (!org) return;
              const fresh = await getUsageSnapshot(db, org.id);
              maybeFireSpendAlarm({
                webhookUrl: env.VOICE_ALERT_SLACK_WEBHOOK ?? undefined,
                organizationId: org.id,
                organizationName: org.name,
                quota: resolveQuota(org.voiceQuota ?? null),
                snapshot: fresh,
                log: request.log,
              });
            } catch (err) {
              request.log.warn({ err }, 'verifier usage record failed');
            }
          })();
        }
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

  // -------------------------------------------------------------------------
  // POST /ai/chat-images/upload — multipart image upload bound to caller.
  //
  // The /ai/chat endpoint requires that any imageStorageKey it receives
  // belongs to a row in chat_image_uploads owned by the calling user (see
  // C-AI-1 in the security audit). This endpoint is the only path that
  // mints such a row.
  //
  // Bounded: 10 MB body, image/png|image/jpeg|image/webp only (verified
  // with magic-byte sniff at the storage layer); per-user rate limit
  // applied by the global limiter. Grants expire after 1 hour and can be
  // consumed exactly once.
  // -------------------------------------------------------------------------
  app.post('/ai/chat-images/upload', async (request, reply) => {
    const { db, storage } = app.ctx;
    const auth = requireAuth(request);
    if (!request.isMultipart()) {
      return reply.badRequest('Expected multipart/form-data.');
    }
    const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) return reply.badRequest('Missing "file" field.');
    const mime = file.mimetype.toLowerCase();
    const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!ALLOWED.has(mime)) {
      return reply.badRequest('Unsupported image type. Use PNG, JPEG, or WebP.');
    }
    const buf = await file.toBuffer();
    if (buf.length === 0) return reply.badRequest('Empty file.');
    // Server-side magic-byte sniff so we don't trust the client's mimetype
    // claim. Mismatch = reject. (Common formats only — extending this is
    // tracked in the storage hardening pass.)
    const sniff = sniffImageMime(buf);
    if (!sniff || sniff !== mime) {
      return reply.badRequest('File contents do not match the declared image type.');
    }
    const filename = sanitizeFilename(file.filename ?? 'image');
    const stored = await storage.putBuffer({
      buffer: buf,
      contentType: mime,
      filename,
      ownerOrganizationId: auth.organizationId,
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
    const [row] = await db
      .insert(schema.chatImageUploads)
      .values({
        storageKey: stored.storageKey,
        userId: auth.userId,
        organizationId: auth.organizationId,
        contentType: mime,
        sizeBytes: String(buf.length),
        expiresAt,
      })
      .returning();
    if (!row) return reply.internalServerError('Failed to register upload.');
    return reply.send({
      storageKey: stored.storageKey,
      sha256: stored.sha256,
      size: buf.length,
      contentType: mime,
      originalFilename: filename,
      // URL is included so the PWA can preview the image client-side
      // between selection and send. Once private buckets land (task #7),
      // this is replaced by a short-lived presigned GET.
      url: storage.publicUrl(stored.storageKey),
      expiresAt: expiresAt.toISOString(),
    });
  });
}

// Wraps the shared mime-sniff helper for the chat-image allowlist.
function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const m = sniffMime(buf);
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/webp') return m;
  return null;
}

function sanitizeFilename(name: string): string {
  // Strip path components, normalize to ASCII alnum + . _ -; cap length.
  const base = name.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.slice(0, 128) || 'image';
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
    source: 'authored' | 'extracted';
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

interface VerifyOutcome {
  result: VerifyResult;
  inputTokens: number;
  outputTokens: number;
}

async function runVerifier(input: {
  anthropic: import('@platform/ai').Anthropic;
  model: string;
  answer: string;
  chunks: SafetyFlaggedChunk[];
  citedChunkIds: string[];
}): Promise<VerifyOutcome | null> {
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
  return {
    result: { sentences, sources, conflict },
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Structured knowledge injection — PM plans + PM schedules + troubleshooting
// guides, fetched per asset model and inlined into the system prompt.
// ---------------------------------------------------------------------------
//
// Why inline rather than embed: these tables are bounded per model
// (a typical splitter has ~3 PM plans with ~20 rows each, ~3
// troubleshooting guides with ~15 rows each — well under 5k tokens
// combined) and the content is structured, not narrative, so chunking
// would just lose the cause→remedy pairing. Inlining gives the model
// the full table to reason about and keeps the RAG pipeline focused
// on long-form documents.
//
// If usage grows: cap per-model output here, or split very long
// troubleshooting guides into chunked rows in document_chunks with a
// synthetic doc per guide.

// Row shapes for the paired-causes jsonb. Mirrors the canonical 0029
// shape and the legacy 0028 + pre-0028 fields for migrate-on-read.
type RemedyStep = { text: string; documentId?: string | null };
type PairedCause = {
  cause: string;
  remedy?: string | null;
  remedySteps?: RemedyStep[];
  remedyStyle?: 'bullet' | 'numbered';
  documentId?: string | null;
};

// Per-instance live state — open work orders, recent service history,
// PM status snapshot. Three small lists; total context cost is
// negligible (~hundreds of tokens) and the answer-quality lift is
// large (the AI can reason about THIS unit's actual state).
async function buildLiveAssetStateBlock(
  db: Database,
  assetInstanceId: string,
): Promise<string> {
  const HISTORY_LIMIT = 8;
  const WORK_ORDER_LIMIT = 5;

  const [openWOs, scheduleHistory, planHistory] = await Promise.all([
    db.query.workOrders.findMany({
      where: and(
        eq(schema.workOrders.assetInstanceId, assetInstanceId),
        inArray(schema.workOrders.status, [
          'open',
          'acknowledged',
          'in_progress',
          'blocked',
        ]),
      ),
      orderBy: [desc(schema.workOrders.openedAt)],
      limit: WORK_ORDER_LIMIT,
      columns: {
        id: true,
        title: true,
        description: true,
        severity: true,
        status: true,
        openedAt: true,
      },
    }),
    db.query.pmServiceRecords.findMany({
      where: eq(schema.pmServiceRecords.assetInstanceId, assetInstanceId),
      orderBy: [desc(schema.pmServiceRecords.performedAt)],
      limit: HISTORY_LIMIT,
      with: {
        schedule: { columns: { name: true } },
      },
    }),
    db.query.pmPlanServiceRecords.findMany({
      where: eq(schema.pmPlanServiceRecords.assetInstanceId, assetInstanceId),
      orderBy: [desc(schema.pmPlanServiceRecords.performedAt)],
      limit: HISTORY_LIMIT,
      with: {
        plan: { columns: { name: true } },
      },
    }),
  ]);

  // Merged + sorted recent service history (schedules + plan buckets).
  const recentService = [
    ...scheduleHistory.map((h) => ({
      when: h.performedAt,
      label: h.schedule?.name ?? 'Ad-hoc service',
      kind: 'SCHEDULE' as const,
    })),
    ...planHistory.map((h) => ({
      when: h.performedAt,
      label: `${h.plan?.name ?? 'PM plan'} · ${PM_PLAN_FREQUENCY_LABEL[h.frequency]}`,
      kind: 'PM_PLAN' as const,
    })),
  ]
    .sort((a, b) => b.when.getTime() - a.when.getTime())
    .slice(0, HISTORY_LIMIT);

  if (openWOs.length === 0 && recentService.length === 0) {
    // Nothing to add — return empty so the prompt doesn't grow with
    // an empty header that wastes tokens.
    return '';
  }

  const sections: string[] = ['\n\n## Live asset state'];

  if (openWOs.length > 0) {
    sections.push('', 'OPEN WORK ORDERS (on this specific unit):');
    for (const wo of openWOs) {
      const opened = wo.openedAt.toISOString().slice(0, 10);
      const desc = wo.description ? ` — ${wo.description.slice(0, 200)}` : '';
      sections.push(
        `- [${wo.severity.toUpperCase()}] ${wo.title} (opened ${opened}, status=${wo.status})${desc}`,
      );
    }
  } else {
    sections.push('', 'OPEN WORK ORDERS: none.');
  }

  if (recentService.length > 0) {
    sections.push('', 'RECENT SERVICE HISTORY (this unit, newest first):');
    for (const r of recentService) {
      const when = r.when.toISOString().slice(0, 10);
      sections.push(`- ${when} · ${r.kind} · ${r.label}`);
    }
  } else {
    sections.push('', 'RECENT SERVICE HISTORY: no records on this unit yet.');
  }

  sections.push(
    '',
    'Use this state to answer questions like "when was X last performed", "is anything overdue", "what work is open on this unit". Cite the appropriate doc/procedure when recommending an action.',
  );

  return sections.join('\n');
}

async function buildStructuredKnowledgeBlock(
  db: Database,
  assetModelId: string,
): Promise<string> {
  const [plans, schedules, guides, bomEntries] = await Promise.all([
    db.query.pmPlans.findMany({
      where: and(
        eq(schema.pmPlans.assetModelId, assetModelId),
        eq(schema.pmPlans.disabled, false),
      ),
      orderBy: [asc(schema.pmPlans.orderingHint), asc(schema.pmPlans.createdAt)],
      with: {
        items: {
          orderBy: [
            asc(schema.pmPlanItems.orderingHint),
            asc(schema.pmPlanItems.createdAt),
          ],
          with: { document: { columns: { id: true, title: true } } },
        },
      },
    }),
    db.query.pmSchedules.findMany({
      where: and(
        eq(schema.pmSchedules.assetModelId, assetModelId),
        eq(schema.pmSchedules.disabled, false),
      ),
      orderBy: [asc(schema.pmSchedules.createdAt)],
      with: { document: { columns: { id: true, title: true } } },
    }),
    db.query.troubleshootingGuides.findMany({
      where: and(
        eq(schema.troubleshootingGuides.assetModelId, assetModelId),
        eq(schema.troubleshootingGuides.disabled, false),
      ),
      orderBy: [
        asc(schema.troubleshootingGuides.orderingHint),
        asc(schema.troubleshootingGuides.createdAt),
      ],
      with: {
        items: {
          orderBy: [
            asc(schema.troubleshootingItems.orderingHint),
            asc(schema.troubleshootingItems.createdAt),
          ],
        },
      },
    }),
    // BOM (top-level parts on this asset model). Drives "what is
    // this part?" / "is the X broken?" — the vision flow and the
    // text chat both rely on having the part catalog inline so
    // model answers can match against authored part names + PNs.
    db.query.bomEntries.findMany({
      where: eq(schema.bomEntries.assetModelId, assetModelId),
      with: {
        part: {
          columns: {
            id: true,
            oemPartNumber: true,
            displayName: true,
            description: true,
          },
        },
      },
    }),
  ]);

  const sections: string[] = [];

  if (plans.length > 0) {
    const planBlocks = plans.map((p) => {
      // Group items by frequency so the AI can answer "what should I
      // check daily?" without scanning the whole table. Within a
      // frequency, items keep their authored order.
      const byFreq = new Map<string, typeof p.items>();
      for (const it of p.items) {
        const arr = byFreq.get(it.frequency) ?? [];
        arr.push(it);
        byFreq.set(it.frequency, arr);
      }
      const freqOrder = ['D', 'W', 'M', 'Q', 'S', 'Y'] as const;
      const lines: string[] = [`[Plan: ${p.name}]`];
      if (p.description) lines.push(`  ${p.description}`);
      for (const f of freqOrder) {
        const items = byFreq.get(f);
        if (!items || items.length === 0) continue;
        lines.push(`  ${PM_PLAN_FREQUENCY_LABEL[f]}:`);
        for (const it of items) {
          const remarks = it.remarks ? `. Remarks: ${it.remarks}` : '';
          const proc = it.document
            ? ` [procedure: ${it.document.title}]`
            : '';
          lines.push(
            `    - ${it.component} — ${it.checkText}${remarks}${proc}`,
          );
        }
      }
      return lines.join('\n');
    });
    sections.push(
      `PREVENTIVE MAINTENANCE PLANS (per-row checklist with frequency):\n${planBlocks.join('\n\n')}`,
    );
  }

  if (schedules.length > 0) {
    const lines = schedules.map((s) => {
      const cadence =
        s.cadenceKind === 'days'
          ? `every ${s.cadenceValue} day(s)`
          : `cadence=${s.cadenceKind}:${s.cadenceValue}`;
      const proc = s.document ? ` [procedure: ${s.document.title}]` : '';
      const desc = s.description ? ` — ${s.description}` : '';
      return `- ${s.name} (${cadence})${desc}${proc}`;
    });
    sections.push(
      `PM SCHEDULES (calendar-based recurring procedures for this model):\n${lines.join('\n')}`,
    );
  }

  if (guides.length > 0) {
    const guideBlocks = guides.map((g) => {
      const lines: string[] = [`[Guide: ${g.name}]`];
      if (g.description) lines.push(`  ${g.description}`);
      for (const item of g.items) {
        lines.push(`  Symptom: ${item.symptom}`);
        // Migrate-on-read for the causes jsonb. Prefer paired causes
        // (0028+) with remedySteps (0029+). Fall back to the older
        // single-string remedy, then to the legacy per-item cause +
        // remedy text columns.
        const paired = (item.causes ?? []) as PairedCause[];
        const validPaired = paired.filter(
          (c) =>
            c.cause.trim().length > 0 ||
            (c.remedy ?? '').trim().length > 0 ||
            (c.remedySteps ?? []).some((s) => s.text.trim().length > 0),
        );
        if (validPaired.length > 0) {
          for (const c of validPaired) {
            if (c.cause.trim()) lines.push(`    - Cause: ${c.cause.trim()}`);
            const steps =
              c.remedySteps && c.remedySteps.length > 0
                ? c.remedySteps
                : c.remedy
                  ? [{ text: c.remedy, documentId: c.documentId ?? null }]
                  : [];
            const validSteps = steps.filter((s) => s.text.trim().length > 0);
            if (validSteps.length > 0) {
              const style = c.remedyStyle === 'numbered' ? 'numbered' : 'bulleted';
              lines.push(`      Remedy (${style}):`);
              validSteps.forEach((s, i) => {
                const marker = c.remedyStyle === 'numbered' ? `${i + 1}.` : '-';
                lines.push(`        ${marker} ${s.text.trim()}`);
              });
            }
          }
        } else if (item.cause || item.remedy) {
          // Pre-0028 unpaired free-text fields.
          if (item.cause) lines.push(`    - Cause: ${item.cause}`);
          if (item.remedy) lines.push(`      Remedy: ${item.remedy}`);
        }
      }
      return lines.join('\n');
    });
    sections.push(
      `TROUBLESHOOTING GUIDES (symptom → cause → remedy steps):\n${guideBlocks.join('\n\n')}`,
    );
  }

  if (bomEntries.length > 0) {
    const lines = bomEntries.map((b) => {
      const p = b.part;
      if (!p) return null;
      const pn = p.oemPartNumber ? `[${p.oemPartNumber}] ` : '';
      const pos = b.positionRef ? ` (pos ${b.positionRef})` : '';
      const desc = p.description
        ? ` — ${p.description.replace(/\s+/g, ' ').slice(0, 140)}`
        : '';
      return `- ${pn}${p.displayName}${pos}${desc}`;
    });
    sections.push(
      `PART CATALOG (bill of materials for this asset model):\n${lines.filter(Boolean).join('\n')}`,
    );
  }

  if (sections.length === 0) return '';

  return (
    '\n\n' +
    sections.join('\n\n') +
    '\n\nWhen the user asks about preventive maintenance, checks, ' +
    'frequencies, schedules, symptoms, faults, or how to diagnose a ' +
    'problem, draw your answer directly from the PM PLANS, PM SCHEDULES, ' +
    'and TROUBLESHOOTING GUIDES above — these are the authoritative ' +
    'source for this asset model. Cite the plan or guide by name in ' +
    'your prose. If the user describes a symptom that matches one in a ' +
    'troubleshooting guide, list the possible causes and their remedy ' +
    'steps in the order shown.\n\n' +
    'When the user uploads a photo of a part and asks "what is this" or ' +
    '"what does this do", compare what you see against the PART CATALOG ' +
    'above. If a single entry plausibly matches the visible part, name ' +
    'it with its OEM number; if multiple plausibly match, list the top ' +
    'candidates with what would distinguish them. Do not invent a part ' +
    'name that is not in the catalog.'
  );
}
