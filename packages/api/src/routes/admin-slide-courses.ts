// Admin authoring API for slide courses — PPTX-derived eLearning experiences.
//
// Surface:
//   GET    /admin/slide-decks/by-document/:documentId       deck lookup by parent doc
//   GET    /admin/slide-decks/:id                           deck + slides + interactions
//   PATCH  /admin/slide-decks/:id                           passThreshold, etc.
//   POST   /admin/slide-decks/:id/retry-conversion          re-enqueue extraction
//
//   PATCH  /admin/slide-decks/:id/slides/:slideId           title, script, gate, ordering
//   POST   /admin/slide-decks/:id/slides/:slideId/voiceover (multipart MP3 upload)
//   DELETE /admin/slide-decks/:id/slides/:slideId/voiceover
//   PATCH  /admin/slide-decks/:id/slides/:slideId/voiceover-duration  client probe
//
//   POST   /admin/slide-decks/:id/reorder                   bulk update slide orderingHint
//
//   POST   /admin/slide-decks/:id/slides/:slideId/interactions    create
//   PATCH  /admin/slide-interactions/:interactionId               update
//   DELETE /admin/slide-interactions/:interactionId               remove
//   POST   /admin/slide-decks/:id/interactions/reorder            bulk per-slide reorder
//
// All writes are scoped to the deck's document's owner org and authenticated
// against the admin's home-org tree. Editing is allowed on published content-
// pack versions because slide-course authoring is treated like an additive
// overlay (same rationale as document_sections — see admin-sections.ts).

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import sharp from 'sharp';
import { schema, type Database } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import {
  SlideInteractionConfigSchema,
  SlideNavigationGateSchema,
  SlideMcqConfigSchema,
  SlideTrueFalseConfigSchema,
  SlideDragMatchConfigSchema,
  SlideShortAnswerAiConfigSchema,
} from '@platform/shared';
import { enqueueExtraction } from '../lib/extraction.js';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import { sniffMime } from '../lib/mime-sniff.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SLIDE_IMAGE_BYTES = 15 * 1024 * 1024;
const ACCEPTED_SLIDE_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const SAFE_SLIDE_IMAGE_SNIFFED = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const MAX_VOICEOVER_BYTES = 25 * 1024 * 1024;
const ACCEPTED_VOICEOVER_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
]);
// Sniffed MIME whitelist (post-magic-byte). MP3 sniffs as audio/mpeg; M4A
// sniffs as audio/mp4 because container == MP4.
const SAFE_VOICEOVER_SNIFFED = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
]);

// ---------------------------------------------------------------------------
// ensureTrainingModuleForDeck
//
// When an author creates a slide deck — either manually or by opting in
// to auto-conversion — we want a training module to wrap it so the deck
// shows up in /training and in the PWA's training tab without the
// author having to navigate over and click "Add slide course" by hand.
// That step has been a consistent source of "I authored a course and
// nothing shows up" confusion.
//
// We skip the auto-wrap when an activity of kind='slide_course' already
// references this deck, so re-running the create endpoint stays
// idempotent. The module's title defaults to the document title; the
// author can rename it from /training later.
// ---------------------------------------------------------------------------

async function ensureTrainingModuleForDeck(
  db: Database,
  doc: typeof schema.documents.$inferSelect,
  slideDeckId: string,
): Promise<{ moduleId: string; activityId: string; created: boolean }> {
  const existingActivity = await db.query.activities.findFirst({
    where: eq(schema.activities.kind, 'slide_course'),
    // We can't easily filter on a JSONB key from drizzle's relation
    // query without raw SQL — pull a small set and match in JS. There
    // are typically very few slide_course activities per version.
    columns: { id: true, trainingModuleId: true, config: true },
  });
  if (
    existingActivity &&
    (existingActivity.config as { slideDeckId?: string }).slideDeckId === slideDeckId
  ) {
    return {
      moduleId: existingActivity.trainingModuleId,
      activityId: existingActivity.id,
      created: false,
    };
  }
  // Pre-scoped activity search across all modules in this version. We
  // do this second to keep the easy path above cheap; the JS-side scan
  // here only runs when the easy lookup misses.
  const versionActivities = await db
    .select({
      id: schema.activities.id,
      moduleId: schema.activities.trainingModuleId,
      config: schema.activities.config,
    })
    .from(schema.activities)
    .innerJoin(
      schema.trainingModules,
      eq(schema.activities.trainingModuleId, schema.trainingModules.id),
    )
    .where(
      and(
        eq(schema.activities.kind, 'slide_course'),
        eq(schema.trainingModules.contentPackVersionId, doc.contentPackVersionId),
      ),
    );
  const match = versionActivities.find(
    (a) => (a.config as { slideDeckId?: string }).slideDeckId === slideDeckId,
  );
  if (match) {
    return { moduleId: match.moduleId, activityId: match.id, created: false };
  }

  // No existing activity — create a fresh module + activity. We default
  // the module's pass-threshold to the deck's (0.8 is reasonable) and
  // leave estimatedMinutes blank for the author to fill in.
  return await db.transaction(async (tx) => {
    const [module] = await tx
      .insert(schema.trainingModules)
      .values({
        contentPackVersionId: doc.contentPackVersionId,
        title: doc.title,
        description: null,
        passThreshold: 0.8,
      })
      .returning();
    if (!module) throw new Error('Failed to create training module.');
    const [activity] = await tx
      .insert(schema.activities)
      .values({
        trainingModuleId: module.id,
        kind: 'slide_course',
        title: doc.title,
        config: { slideDeckId },
        weight: 1,
        orderingHint: 0,
      })
      .returning();
    if (!activity) throw new Error('Failed to create slide_course activity.');
    return { moduleId: module.id, activityId: activity.id, created: true };
  });
}

// ---------------------------------------------------------------------------
// Loaders + scope guards
// ---------------------------------------------------------------------------

interface DeckCtx {
  deck: typeof schema.slideDecks.$inferSelect;
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
}

async function loadDeckForWrite(
  db: Database,
  slideDeckId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<DeckCtx | null> {
  const deck = await db.query.slideDecks.findFirst({
    where: eq(schema.slideDecks.id, slideDeckId),
  });
  if (!deck) return null;
  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, deck.documentId),
    with: { packVersion: { with: { pack: true } } },
  });
  if (!doc) return null;
  requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
  return { deck, doc, ownerOrganizationId: doc.packVersion.pack.ownerOrganizationId };
}

async function loadSlideForWrite(
  db: Database,
  slideDeckId: string,
  slideId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<
  | (DeckCtx & {
      slide: typeof schema.slideDeckSlides.$inferSelect;
    })
  | null
> {
  const deckCtx = await loadDeckForWrite(db, slideDeckId, scope);
  if (!deckCtx) return null;
  const slide = await db.query.slideDeckSlides.findFirst({
    where: and(
      eq(schema.slideDeckSlides.id, slideId),
      eq(schema.slideDeckSlides.slideDeckId, slideDeckId),
    ),
  });
  if (!slide) return null;
  return { ...deckCtx, slide };
}

async function loadInteractionForWrite(
  db: Database,
  interactionId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<
  | (DeckCtx & {
      slide: typeof schema.slideDeckSlides.$inferSelect;
      interaction: typeof schema.slideInteractions.$inferSelect;
    })
  | null
> {
  const interaction = await db.query.slideInteractions.findFirst({
    where: eq(schema.slideInteractions.id, interactionId),
  });
  if (!interaction) return null;
  const slide = await db.query.slideDeckSlides.findFirst({
    where: eq(schema.slideDeckSlides.id, interaction.slideId),
  });
  if (!slide) return null;
  const deckCtx = await loadDeckForWrite(db, slide.slideDeckId, scope);
  if (!deckCtx) return null;
  return { ...deckCtx, slide, interaction };
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

function deckDto(
  deck: typeof schema.slideDecks.$inferSelect,
  doc: typeof schema.documents.$inferSelect,
): {
  id: string;
  documentId: string;
  documentTitle: string;
  conversionStatus: typeof deck.conversionStatus;
  conversionError: string | null;
  conversionStartedAt: string | null;
  conversionCompletedAt: string | null;
  slideCount: number;
  passThreshold: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: deck.id,
    documentId: deck.documentId,
    documentTitle: doc.title,
    conversionStatus: deck.conversionStatus,
    conversionError: deck.conversionError,
    conversionStartedAt: deck.conversionStartedAt
      ? deck.conversionStartedAt.toISOString()
      : null,
    conversionCompletedAt: deck.conversionCompletedAt
      ? deck.conversionCompletedAt.toISOString()
      : null,
    slideCount: deck.slideCount,
    passThreshold: deck.passThreshold,
    createdAt: deck.createdAt.toISOString(),
    updatedAt: deck.updatedAt.toISOString(),
  };
}

function slideDto(
  slide: typeof schema.slideDeckSlides.$inferSelect,
  imageUrl: string | null,
  voiceoverUrl: string | null,
) {
  return {
    id: slide.id,
    slideDeckId: slide.slideDeckId,
    slideIndex: slide.slideIndex,
    orderingHint: slide.orderingHint,
    title: slide.title,
    speakerNotesMarkdown: slide.speakerNotesMarkdown,
    scriptMarkdown: slide.scriptMarkdown,
    imageStorageKey: slide.imageStorageKey,
    imageUrl,
    imageWidth: slide.imageWidth,
    imageHeight: slide.imageHeight,
    voiceoverStorageKey: slide.voiceoverStorageKey,
    voiceoverUrl,
    voiceoverDurationSec: slide.voiceoverDurationSec,
    navigationGate: slide.navigationGate,
    updatedAt: slide.updatedAt.toISOString(),
  };
}

function interactionDto(row: typeof schema.slideInteractions.$inferSelect) {
  return {
    id: row.id,
    slideId: row.slideId,
    kind: row.kind,
    prompt: row.prompt,
    config: row.config,
    weight: row.weight,
    orderingHint: row.orderingHint,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Per-kind config validation. Server is authoritative about correct answers;
// the discriminator's `kind` must match the interaction.kind that's already
// stored. We re-validate on every PATCH so a buggy admin client can't write
// a misshaped row that breaks the player.
// ---------------------------------------------------------------------------

function validateInteractionConfig(
  kind: typeof schema.slideInteractions.$inferSelect['kind'],
  rawConfig: unknown,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    if (kind === 'mcq') {
      parsed = SlideMcqConfigSchema.parse(rawConfig);
    } else if (kind === 'true_false') {
      parsed = SlideTrueFalseConfigSchema.parse(rawConfig);
    } else if (kind === 'drag_match') {
      parsed = SlideDragMatchConfigSchema.parse(rawConfig);
    } else {
      parsed = SlideShortAnswerAiConfigSchema.parse(rawConfig);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid config' };
  }
  // Defensive sanity: for MCQ ensure correctIndex is within options range.
  if (kind === 'mcq') {
    const c = parsed as z.infer<typeof SlideMcqConfigSchema>;
    if (c.correctIndex >= c.options.length) {
      return { ok: false, error: 'correctIndex must be < options.length' };
    }
  }
  // Drag-match: require unique left labels.
  if (kind === 'drag_match') {
    const c = parsed as z.infer<typeof SlideDragMatchConfigSchema>;
    const labels = new Set(c.pairs.map((p) => p.left));
    if (labels.size !== c.pairs.length) {
      return { ok: false, error: 'left-side labels must be unique' };
    }
  }
  return { ok: true, config: parsed as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const DeckPatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    passThreshold: z.number().min(0).max(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

const SlidePatchBody = z
  .object({
    title: z.string().max(200).nullable().optional(),
    scriptMarkdown: z.string().max(16000).nullable().optional(),
    navigationGate: SlideNavigationGateSchema.optional(),
    orderingHint: z.number().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

const ReorderBody = z.object({
  orderings: z
    .array(
      z.object({
        slideId: UuidSchema,
        orderingHint: z.number(),
      }),
    )
    .min(1)
    .max(500),
});

const InteractionCreateBody = SlideInteractionConfigSchema.and(
  z.object({
    prompt: z.string().min(1).max(2000),
    weight: z.number().min(0).max(10).default(1),
    orderingHint: z.number().default(0),
  }),
);

const InteractionPatchBody = z
  .object({
    prompt: z.string().min(1).max(2000).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    weight: z.number().min(0).max(10).optional(),
    orderingHint: z.number().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

const InteractionReorderBody = z.object({
  slideId: UuidSchema,
  orderings: z
    .array(z.object({ interactionId: UuidSchema, orderingHint: z.number() }))
    .min(1)
    .max(50),
});

const VoiceoverDurationBody = z.object({
  voiceoverDurationSec: z.number().min(0).max(60 * 60),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerAdminSlideCourses(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /admin/slide-decks/by-document/:documentId
  //
  // The admin UI opens the course editor from the document detail page —
  // it has the documentId, not the slideDeckId. This endpoint returns
  // null when no deck row exists yet (i.e. conversion hasn't started).
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/slide-decks/by-document/:documentId',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);

      const deck = await db.query.slideDecks.findFirst({
        where: eq(schema.slideDecks.documentId, doc.id),
      });
      if (!deck) return reply.send(null);
      return reply.send(deckDto(deck, doc));
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/slide-decks/:id
  //
  // Full deck for the editor: deck row + ordered slides + interactions per
  // slide. Resolves storage keys to signed URLs so the admin <img> + <audio>
  // tags can render without a second round-trip.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/admin/slide-decks/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      // Self-healing backfill: an older deck created before
      // auto-wrap landed won't have a training module yet. Ensure
      // one exists on every editor load (idempotent — no-op if
      // already wrapped).
      await ensureTrainingModuleForDeck(db, ctx.doc, ctx.deck.id);

      const slides = await db.query.slideDeckSlides.findMany({
        where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
        orderBy: [
          asc(schema.slideDeckSlides.orderingHint),
          asc(schema.slideDeckSlides.slideIndex),
        ],
      });

      const allInteractions = slides.length
        ? await db.query.slideInteractions.findMany({
            where: inArray(
              schema.slideInteractions.slideId,
              slides.map((s) => s.id),
            ),
            orderBy: [asc(schema.slideInteractions.orderingHint)],
          })
        : [];

      const slideMap = new Map<string, ReturnType<typeof slideDto>>();
      for (const s of slides) {
        const imageUrl = s.imageStorageKey ? storage.publicUrl(s.imageStorageKey) : null;
        const voiceoverUrl = s.voiceoverStorageKey
          ? storage.publicUrl(s.voiceoverStorageKey)
          : null;
        slideMap.set(s.id, slideDto(s, imageUrl, voiceoverUrl));
      }

      const byInteraction: Record<string, ReturnType<typeof interactionDto>[]> = {};
      for (const i of allInteractions) {
        if (!byInteraction[i.slideId]) byInteraction[i.slideId] = [];
        byInteraction[i.slideId]!.push(interactionDto(i));
      }

      return reply.send({
        deck: deckDto(ctx.deck, ctx.doc),
        slides: slides.map((s) => ({
          ...slideMap.get(s.id)!,
          interactions: byInteraction[s.id] ?? [],
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/slide-decks/:id
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: z.infer<typeof DeckPatchBody> }>(
    '/admin/slide-decks/:id',
    { schema: { params: z.object({ id: UuidSchema }), body: DeckPatchBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (request.body.passThreshold !== undefined)
        patch.passThreshold = request.body.passThreshold;
      const [updated] = await db
        .update(schema.slideDecks)
        .set(patch)
        .where(eq(schema.slideDecks.id, ctx.deck.id))
        .returning();
      if (!updated) return reply.internalServerError('Failed to update slide deck.');

      // Title is duplicated across documents.title + training_modules.title
      // + activities.title so listing endpoints don't have to JOIN. The
      // editor's single rename input fans the change out to all three so
      // /training, the PWA training tab, and the course header stay in
      // sync. Done in a transaction; nothing partial-commits.
      let updatedDoc = ctx.doc;
      if (request.body.title !== undefined) {
        const nextTitle = request.body.title;
        await db.transaction(async (tx) => {
          await tx
            .update(schema.documents)
            .set({ title: nextTitle })
            .where(eq(schema.documents.id, ctx.doc.id));
          // Find the slide_course activities pointing at this deck —
          // there is normally exactly one, but the iteration is safe in
          // the unlikely event someone double-published.
          const slideCourseActivities = await tx
            .select({
              id: schema.activities.id,
              trainingModuleId: schema.activities.trainingModuleId,
              config: schema.activities.config,
            })
            .from(schema.activities)
            .where(eq(schema.activities.kind, 'slide_course'));
          for (const a of slideCourseActivities) {
            const cfgDeckId = (a.config as { slideDeckId?: string }).slideDeckId;
            if (cfgDeckId !== ctx.deck.id) continue;
            await tx
              .update(schema.activities)
              .set({ title: nextTitle })
              .where(eq(schema.activities.id, a.id));
            await tx
              .update(schema.trainingModules)
              .set({ title: nextTitle })
              .where(eq(schema.trainingModules.id, a.trainingModuleId));
          }
        });
        updatedDoc = { ...ctx.doc, title: nextTitle };
      }

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck.updated',
        targetType: 'slide_deck',
        targetId: ctx.deck.id,
        payload: {
          passThreshold: updated.passThreshold,
          titleChanged: request.body.title !== undefined,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send(deckDto(updated, updatedDoc));
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/content-pack-versions/:versionId/training-courses
  //
  // One-shot "Add training" affordance. Creates the document row (kind=
  // 'slides', no PPTX attached), the slide_decks row in ready state, the
  // wrapping training module, and the slide_course activity. Returns
  // both IDs so the admin UI can route the author straight into the
  // course editor. Replaces the old multi-step flow (Add document → pick
  // kind=slides → upload → open document → Open course editor) with a
  // single click.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { versionId: string };
    Body: { title: string };
  }>(
    '/admin/content-pack-versions/:versionId/training-courses',
    {
      schema: {
        params: z.object({ versionId: UuidSchema }),
        body: z.object({ title: z.string().min(1).max(200) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);
      if (version.status !== 'draft' && !request.auth?.platformAdmin) {
        return reply.badRequest(
          'Training can only be added to draft content pack versions.',
        );
      }

      const result = await db.transaction(async (tx) => {
        const [document] = await tx
          .insert(schema.documents)
          .values({
            contentPackVersionId: version.id,
            kind: 'slides',
            title: request.body.title,
            extractionStatus: 'not_applicable',
          })
          .returning();
        if (!document) throw new Error('Failed to create document row.');
        const [deck] = await tx
          .insert(schema.slideDecks)
          .values({
            documentId: document.id,
            conversionStatus: 'ready',
            conversionCompletedAt: new Date(),
            slideCount: 0,
          })
          .returning();
        if (!deck) throw new Error('Failed to create slide_decks row.');
        return { document, deck };
      });

      // Wrap in a training module + activity so /training and the PWA
      // surface the course without a separate "publish" step.
      const wrap = await ensureTrainingModuleForDeck(
        db,
        result.document,
        result.deck.id,
      );

      await db.insert(schema.auditEvents).values({
        organizationId: version.pack.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck.training_course_created',
        targetType: 'slide_deck',
        targetId: result.deck.id,
        payload: {
          documentId: result.document.id,
          trainingModuleId: wrap.moduleId,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send({
        documentId: result.document.id,
        slideDeckId: result.deck.id,
        trainingModuleId: wrap.moduleId,
        activityId: wrap.activityId,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/slide-deck
  //
  // Create a blank slide deck for manual authoring. Used when an author
  // wants to skip PPTX auto-conversion (LibreOffice fidelity can be
  // poor on complex decks) and upload per-slide PNGs by hand. The deck
  // is marked conversion='ready' immediately so the player accepts it;
  // slides are added one at a time via POST /slides below.
  // -------------------------------------------------------------------------
  app.post<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/slide-deck',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);

      const existing = await db.query.slideDecks.findFirst({
        where: eq(schema.slideDecks.documentId, doc.id),
      });
      if (existing) return reply.send(deckDto(existing, doc));

      const [created] = await db
        .insert(schema.slideDecks)
        .values({
          documentId: doc.id,
          conversionStatus: 'ready',
          conversionCompletedAt: new Date(),
          slideCount: 0,
        })
        .returning();
      if (!created) return reply.internalServerError('Failed to create slide deck.');

      // Auto-wrap in a training module so the deck shows up in /training
      // and the PWA training tab without a separate "Add slide course"
      // step. Idempotent on re-runs.
      await ensureTrainingModuleForDeck(db, doc, created.id);

      await db.insert(schema.auditEvents).values({
        organizationId: doc.packVersion.pack.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck.manually_created',
        targetType: 'slide_deck',
        targetId: created.id,
        payload: { documentId: doc.id },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send(deckDto(created, doc));
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/slide-deck/auto-convert
  //
  // Opt in to PPTX → PNG auto-conversion. Creates (or resets) the deck
  // row to 'pending' and re-enqueues the document so the worker picks
  // it up. We deliberately don't run conversion as a side-effect of
  // every PPTX upload — many decks ship with custom fonts or animations
  // that LibreOffice can't render faithfully, and the manual flow gives
  // pixel-perfect results for those cases. This endpoint is the
  // explicit opt-in.
  // -------------------------------------------------------------------------
  app.post<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/slide-deck/auto-convert',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
      if (doc.kind !== 'slides') {
        return reply.badRequest(
          'Auto-conversion only applies to documents with kind="slides".',
        );
      }
      if (!doc.storageKey) {
        return reply.badRequest(
          'This document has no PPTX file attached — nothing to convert.',
        );
      }

      const existing = await db.query.slideDecks.findFirst({
        where: eq(schema.slideDecks.documentId, doc.id),
      });
      const [deck] = existing
        ? await db
            .update(schema.slideDecks)
            .set({
              conversionStatus: 'pending',
              conversionError: null,
              conversionStartedAt: null,
              conversionCompletedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.slideDecks.id, existing.id))
            .returning()
        : await db
            .insert(schema.slideDecks)
            .values({
              documentId: doc.id,
              conversionStatus: 'pending',
              slideCount: 0,
            })
            .returning();
      if (!deck) return reply.internalServerError('Failed to create slide deck row.');

      // Auto-wrap in a training module immediately. The activity is
      // valid even before conversion finishes — the PWA player handles
      // 'pending'/'processing' status with a friendly banner.
      await ensureTrainingModuleForDeck(db, doc, deck.id);

      await enqueueExtraction(db, doc.id);

      await db.insert(schema.auditEvents).values({
        organizationId: doc.packVersion.pack.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck.auto_convert_requested',
        targetType: 'slide_deck',
        targetId: deck.id,
        payload: { documentId: doc.id },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send(deckDto(deck, doc));
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/slides  (multipart PNG/JPEG/WebP upload)
  //
  // Append a new slide with an uploaded image. The deck does not need to
  // be a PPTX-derived one — this works for fully-manual decks too.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/slide-decks/:id/slides',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();
      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data with an image file.');
      }
      const file = await request.file();
      if (!file) return reply.badRequest('Missing image file.');

      const mime = (file.mimetype || '').toLowerCase();
      if (!ACCEPTED_SLIDE_IMAGE_MIMES.has(mime)) {
        return reply.unsupportedMediaType(
          `Unsupported image type: ${mime}. Use PNG, JPEG, or WebP.`,
        );
      }
      const chunks: Buffer[] = [];
      for await (const c of file.file as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.byteLength === 0) return reply.badRequest('Empty image.');
      if (buf.byteLength > MAX_SLIDE_IMAGE_BYTES) {
        return reply.payloadTooLarge(
          `Image exceeds ${Math.round(MAX_SLIDE_IMAGE_BYTES / 1024 / 1024)} MB limit.`,
        );
      }
      const sniffed = sniffMime(buf);
      if (!sniffed || !SAFE_SLIDE_IMAGE_SNIFFED.has(sniffed)) {
        return reply.unsupportedMediaType(
          'File content does not match a supported image format.',
        );
      }

      const meta = await sharp(buf).metadata();
      const stored = await storage.putBuffer({
        buffer: buf,
        filename: file.filename || 'slide.png',
        contentType: sniffed,
        ownerOrganizationId: ctx.ownerOrganizationId,
      });

      // Append at the end: max(slideIndex, orderingHint) + 1. slideIndex
      // is 0-based and historically corresponds to PPTX position; for
      // manual decks we just keep it monotonic.
      const result = await db.transaction(async (tx) => {
        const last = await tx.query.slideDeckSlides.findFirst({
          where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
          orderBy: [desc(schema.slideDeckSlides.slideIndex)],
        });
        const nextIndex = (last?.slideIndex ?? -1) + 1;
        const lastOrder = await tx.query.slideDeckSlides.findFirst({
          where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
          orderBy: [desc(schema.slideDeckSlides.orderingHint)],
        });
        const nextOrder = (lastOrder?.orderingHint ?? -1) + 1;
        const [row] = await tx
          .insert(schema.slideDeckSlides)
          .values({
            slideDeckId: ctx.deck.id,
            slideIndex: nextIndex,
            orderingHint: nextOrder,
            imageStorageKey: stored.storageKey,
            imageWidth: meta.width ?? 0,
            imageHeight: meta.height ?? 0,
          })
          .returning();
        // Bump the deck's slide_count so the player and admin
        // dashboards see the right total.
        await tx
          .update(schema.slideDecks)
          .set({
            slideCount: sql`${schema.slideDecks.slideCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.slideDecks.id, ctx.deck.id));
        return row;
      });
      if (!result) return reply.internalServerError('Failed to create slide.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.created',
        targetType: 'slide_deck_slide',
        targetId: result.id,
        payload: { slideIndex: result.slideIndex, contentType: sniffed },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const imageUrl = result.imageStorageKey
        ? storage.publicUrl(result.imageStorageKey)
        : null;
      return reply.send(slideDto(result, imageUrl, null));
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/blank-slide
  //
  // Append a slide with no image — typically used for a dedicated
  // "quiz slide" or section divider. The author can still upload an
  // image later via the PATCH .../image endpoint if they change their
  // mind. Body is JSON, not multipart.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: { title?: string };
  }>(
    '/admin/slide-decks/:id/blank-slide',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({ title: z.string().max(200).optional() }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      const result = await db.transaction(async (tx) => {
        const last = await tx.query.slideDeckSlides.findFirst({
          where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
          orderBy: [desc(schema.slideDeckSlides.slideIndex)],
        });
        const nextIndex = (last?.slideIndex ?? -1) + 1;
        const lastOrder = await tx.query.slideDeckSlides.findFirst({
          where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
          orderBy: [desc(schema.slideDeckSlides.orderingHint)],
        });
        const nextOrder = (lastOrder?.orderingHint ?? -1) + 1;
        const [row] = await tx
          .insert(schema.slideDeckSlides)
          .values({
            slideDeckId: ctx.deck.id,
            slideIndex: nextIndex,
            orderingHint: nextOrder,
            title: request.body.title?.trim() || null,
          })
          .returning();
        await tx
          .update(schema.slideDecks)
          .set({
            slideCount: sql`${schema.slideDecks.slideCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(schema.slideDecks.id, ctx.deck.id));
        return row;
      });
      if (!result) return reply.internalServerError('Failed to create blank slide.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.created_blank',
        targetType: 'slide_deck_slide',
        targetId: result.id,
        payload: { slideIndex: result.slideIndex },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send(slideDto(result, null, null));
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/slide-decks/:id/slides/:slideId/image
  //
  // Replace an existing slide's image. Useful when a single slide was
  // updated in PowerPoint and the author re-exports just that PNG.
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string; slideId: string } }>(
    '/admin/slide-decks/:id/slides/:slideId/image',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();
      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data with an image file.');
      }
      const file = await request.file();
      if (!file) return reply.badRequest('Missing image file.');

      const mime = (file.mimetype || '').toLowerCase();
      if (!ACCEPTED_SLIDE_IMAGE_MIMES.has(mime)) {
        return reply.unsupportedMediaType(
          `Unsupported image type: ${mime}. Use PNG, JPEG, or WebP.`,
        );
      }
      const chunks: Buffer[] = [];
      for await (const c of file.file as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.byteLength === 0) return reply.badRequest('Empty image.');
      if (buf.byteLength > MAX_SLIDE_IMAGE_BYTES) {
        return reply.payloadTooLarge(
          `Image exceeds ${Math.round(MAX_SLIDE_IMAGE_BYTES / 1024 / 1024)} MB limit.`,
        );
      }
      const sniffed = sniffMime(buf);
      if (!sniffed || !SAFE_SLIDE_IMAGE_SNIFFED.has(sniffed)) {
        return reply.unsupportedMediaType(
          'File content does not match a supported image format.',
        );
      }
      const meta = await sharp(buf).metadata();
      const stored = await storage.putBuffer({
        buffer: buf,
        filename: file.filename || 'slide.png',
        contentType: sniffed,
        ownerOrganizationId: ctx.ownerOrganizationId,
      });

      const [updated] = await db
        .update(schema.slideDeckSlides)
        .set({
          imageStorageKey: stored.storageKey,
          imageWidth: meta.width ?? 0,
          imageHeight: meta.height ?? 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.slideDeckSlides.id, ctx.slide.id))
        .returning();
      if (!updated) return reply.internalServerError('Failed to replace image.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.image_replaced',
        targetType: 'slide_deck_slide',
        targetId: updated.id,
        payload: { contentType: sniffed },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const imageUrl = updated.imageStorageKey
        ? storage.publicUrl(updated.imageStorageKey)
        : null;
      const voiceoverUrl = updated.voiceoverStorageKey
        ? storage.publicUrl(updated.voiceoverStorageKey)
        : null;
      return reply.send(slideDto(updated, imageUrl, voiceoverUrl));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/slide-decks/:id/slides/:slideId
  //
  // Remove a slide entirely. Cascades through interactions + answers
  // via the FK. The deck's slide_count is decremented; remaining slides
  // keep their original slideIndex/orderingHint (we don't renumber so
  // existing interaction references stay valid).
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; slideId: string } }>(
    '/admin/slide-decks/:id/slides/:slideId',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();

      await db.transaction(async (tx) => {
        await tx
          .delete(schema.slideDeckSlides)
          .where(eq(schema.slideDeckSlides.id, ctx.slide.id));
        await tx
          .update(schema.slideDecks)
          .set({
            slideCount: sql`GREATEST(${schema.slideDecks.slideCount} - 1, 0)`,
            updatedAt: new Date(),
          })
          .where(eq(schema.slideDecks.id, ctx.deck.id));
      });

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.deleted',
        targetType: 'slide_deck_slide',
        targetId: ctx.slide.id,
        payload: { slideIndex: ctx.slide.slideIndex },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/retry-conversion
  //
  // Flips the parent document back to extraction_status='pending' so the
  // worker picks it up again. Clears slide_decks.conversion_error too so
  // the admin banner doesn't show stale failures during retry.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/admin/slide-decks/:id/retry-conversion',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      await db
        .update(schema.slideDecks)
        .set({
          conversionStatus: 'pending',
          conversionError: null,
          conversionStartedAt: null,
          conversionCompletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.slideDecks.id, ctx.deck.id));
      await enqueueExtraction(db, ctx.doc.id);

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck.retry_conversion',
        targetType: 'slide_deck',
        targetId: ctx.deck.id,
        payload: {},
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/slide-decks/:id/slides/:slideId
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string; slideId: string };
    Body: z.infer<typeof SlidePatchBody>;
  }>(
    '/admin/slide-decks/:id/slides/:slideId',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
        body: SlidePatchBody,
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      const b = request.body;
      if (b.title !== undefined) patch.title = b.title;
      if (b.scriptMarkdown !== undefined) patch.scriptMarkdown = b.scriptMarkdown;
      if (b.navigationGate !== undefined) patch.navigationGate = b.navigationGate;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;

      const [updated] = await db
        .update(schema.slideDeckSlides)
        .set(patch)
        .where(eq(schema.slideDeckSlides.id, ctx.slide.id))
        .returning();
      if (!updated) return reply.internalServerError('Failed to update slide.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.updated',
        targetType: 'slide_deck_slide',
        targetId: ctx.slide.id,
        payload: { fields: Object.keys(b) },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const imageUrl = updated.imageStorageKey
        ? storage.publicUrl(updated.imageStorageKey)
        : null;
      const voiceoverUrl = updated.voiceoverStorageKey
        ? storage.publicUrl(updated.voiceoverStorageKey)
        : null;
      return reply.send(slideDto(updated, imageUrl, voiceoverUrl));
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/slides/:slideId/voiceover  (multipart upload)
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string; slideId: string } }>(
    '/admin/slide-decks/:id/slides/:slideId/voiceover',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();
      if (!request.isMultipart()) {
        return reply.badRequest('Expected multipart/form-data with an audio file.');
      }
      const file = await request.file();
      if (!file) return reply.badRequest('Missing audio file.');
      const mime = (file.mimetype || '').toLowerCase();
      if (!ACCEPTED_VOICEOVER_MIMES.has(mime)) {
        return reply.unsupportedMediaType(
          `Unsupported audio type: ${mime}. Use MP3, M4A, WAV, OGG, or WebM.`,
        );
      }
      const chunks: Buffer[] = [];
      for await (const c of file.file as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.byteLength === 0) return reply.badRequest('Empty audio.');
      if (buf.byteLength > MAX_VOICEOVER_BYTES) {
        return reply.payloadTooLarge('Audio exceeds 25 MB limit.');
      }
      const sniffed = sniffMime(buf);
      if (!sniffed || !SAFE_VOICEOVER_SNIFFED.has(sniffed)) {
        return reply.unsupportedMediaType(
          'File content does not match a supported audio format.',
        );
      }
      const stored = await storage.putBuffer({
        buffer: buf,
        filename: file.filename || `slide-${ctx.slide.id}.audio`,
        contentType: sniffed,
        ownerOrganizationId: ctx.ownerOrganizationId,
      });
      const [updated] = await db
        .update(schema.slideDeckSlides)
        .set({
          voiceoverStorageKey: stored.storageKey,
          // Client probes duration after upload and PATCHes the accurate
          // value back. Leave null until then.
          voiceoverDurationSec: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.slideDeckSlides.id, ctx.slide.id))
        .returning();
      if (!updated) return reply.internalServerError('Failed to attach voiceover.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.voiceover_uploaded',
        targetType: 'slide_deck_slide',
        targetId: ctx.slide.id,
        payload: { mime: sniffed, sizeBytes: stored.size },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send({
        voiceoverStorageKey: stored.storageKey,
        voiceoverUrl: storage.publicUrl(stored.storageKey),
        sizeBytes: stored.size,
        contentType: sniffed,
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/slide-decks/:id/slides/:slideId/voiceover
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; slideId: string } }>(
    '/admin/slide-decks/:id/slides/:slideId/voiceover',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();
      await db
        .update(schema.slideDeckSlides)
        .set({
          voiceoverStorageKey: null,
          voiceoverDurationSec: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.slideDeckSlides.id, ctx.slide.id));
      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck_slide.voiceover_deleted',
        targetType: 'slide_deck_slide',
        targetId: ctx.slide.id,
        payload: {},
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/slide-decks/:id/slides/:slideId/voiceover-duration
  //
  // Client probes duration via HTMLAudioElement.duration after upload and
  // PATCHes the accurate seconds back. Used by the player's
  // require_voiceover gate to know when audio "finished" without relying
  // on the per-play 'ended' event firing on every device.
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string; slideId: string };
    Body: z.infer<typeof VoiceoverDurationBody>;
  }>(
    '/admin/slide-decks/:id/slides/:slideId/voiceover-duration',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
        body: VoiceoverDurationBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();
      if (!ctx.slide.voiceoverStorageKey) {
        return reply.badRequest('No voiceover attached to this slide.');
      }
      await db
        .update(schema.slideDeckSlides)
        .set({
          voiceoverDurationSec: request.body.voiceoverDurationSec,
          updatedAt: new Date(),
        })
        .where(eq(schema.slideDeckSlides.id, ctx.slide.id));
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/reorder
  //
  // Bulk update of orderingHint on slides. The admin UI sends the full
  // ordering after a drag-drop reorder; we apply it in a transaction.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: z.infer<typeof ReorderBody> }>(
    '/admin/slide-decks/:id/reorder',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: ReorderBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      await db.transaction(async (tx) => {
        for (const o of request.body.orderings) {
          await tx
            .update(schema.slideDeckSlides)
            .set({ orderingHint: o.orderingHint, updatedAt: new Date() })
            .where(
              and(
                eq(schema.slideDeckSlides.id, o.slideId),
                eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
              ),
            );
        }
      });
      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_deck.reordered',
        targetType: 'slide_deck',
        targetId: ctx.deck.id,
        payload: { count: request.body.orderings.length },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/slides/:slideId/interactions  — create
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string; slideId: string };
    Body: z.infer<typeof InteractionCreateBody>;
  }>(
    '/admin/slide-decks/:id/slides/:slideId/interactions',
    {
      schema: {
        params: z.object({ id: UuidSchema, slideId: UuidSchema }),
        body: InteractionCreateBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSlideForWrite(
        db,
        request.params.id,
        request.params.slideId,
        scope,
      );
      if (!ctx) return reply.notFound();

      const b = request.body;
      const validated = validateInteractionConfig(b.kind, b.config);
      if (!validated.ok) return reply.badRequest(validated.error);

      const [row] = await db
        .insert(schema.slideInteractions)
        .values({
          slideId: ctx.slide.id,
          kind: b.kind,
          prompt: b.prompt,
          config: validated.config,
          weight: b.weight,
          orderingHint: b.orderingHint,
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create interaction.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_interaction.created',
        targetType: 'slide_interaction',
        targetId: row.id,
        payload: { slideId: row.slideId, kind: row.kind },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send(interactionDto(row));
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/slide-interactions/:interactionId
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { interactionId: string };
    Body: z.infer<typeof InteractionPatchBody>;
  }>(
    '/admin/slide-interactions/:interactionId',
    {
      schema: {
        params: z.object({ interactionId: UuidSchema }),
        body: InteractionPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadInteractionForWrite(db, request.params.interactionId, scope);
      if (!ctx) return reply.notFound();

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      const b = request.body;
      if (b.prompt !== undefined) patch.prompt = b.prompt;
      if (b.weight !== undefined) patch.weight = b.weight;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.config !== undefined) {
        const validated = validateInteractionConfig(ctx.interaction.kind, b.config);
        if (!validated.ok) return reply.badRequest(validated.error);
        patch.config = validated.config;
      }

      const [updated] = await db
        .update(schema.slideInteractions)
        .set(patch)
        .where(eq(schema.slideInteractions.id, ctx.interaction.id))
        .returning();
      if (!updated) return reply.internalServerError('Failed to update interaction.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_interaction.updated',
        targetType: 'slide_interaction',
        targetId: updated.id,
        payload: { fields: Object.keys(b) },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send(interactionDto(updated));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/slide-interactions/:interactionId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { interactionId: string } }>(
    '/admin/slide-interactions/:interactionId',
    { schema: { params: z.object({ interactionId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadInteractionForWrite(db, request.params.interactionId, scope);
      if (!ctx) return reply.notFound();
      await db
        .delete(schema.slideInteractions)
        .where(eq(schema.slideInteractions.id, ctx.interaction.id));
      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'slide_interaction.deleted',
        targetType: 'slide_interaction',
        targetId: ctx.interaction.id,
        payload: {},
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/slide-decks/:id/interactions/reorder
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof InteractionReorderBody>;
  }>(
    '/admin/slide-decks/:id/interactions/reorder',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: InteractionReorderBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDeckForWrite(db, request.params.id, scope);
      if (!ctx) return reply.notFound();

      const slide = await db.query.slideDeckSlides.findFirst({
        where: and(
          eq(schema.slideDeckSlides.id, request.body.slideId),
          eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
        ),
      });
      if (!slide) return reply.notFound();

      await db.transaction(async (tx) => {
        for (const o of request.body.orderings) {
          await tx
            .update(schema.slideInteractions)
            .set({ orderingHint: o.orderingHint, updatedAt: new Date() })
            .where(
              and(
                eq(schema.slideInteractions.id, o.interactionId),
                eq(schema.slideInteractions.slideId, slide.id),
              ),
            );
        }
      });
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/training-modules/:moduleId/slide-course-activities
  //
  // Publishes a converted slide deck as a slide_course activity on a
  // training module. The deck must live in the same content pack
  // version as the module (a course can't reference a deck from a
  // sibling pack), and must be conversion='ready'.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { moduleId: string };
    Body: {
      title: string;
      slideDeckId: string;
      weight?: number;
      orderingHint?: number;
    };
  }>(
    '/admin/training-modules/:moduleId/slide-course-activities',
    {
      schema: {
        params: z.object({ moduleId: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200),
          slideDeckId: UuidSchema,
          weight: z.number().positive().default(1),
          orderingHint: z.number().int().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.moduleId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);
      if (module.packVersion.status !== 'draft' && !request.auth?.platformAdmin) {
        return reply.badRequest('Can only author activities in a draft version.');
      }

      const ctx = await loadDeckForWrite(db, request.body.slideDeckId, scope);
      if (!ctx) return reply.notFound();
      if (ctx.doc.contentPackVersionId !== module.packVersion.id) {
        return reply.badRequest(
          'Slide deck must belong to the same content pack version as the training module.',
        );
      }
      if (ctx.deck.conversionStatus !== 'ready') {
        return reply.badRequest(
          `Slide deck is not ready (status: ${ctx.deck.conversionStatus}).`,
        );
      }

      const [created] = await db
        .insert(schema.activities)
        .values({
          trainingModuleId: module.id,
          kind: 'slide_course',
          title: request.body.title,
          config: { slideDeckId: ctx.deck.id },
          weight: request.body.weight,
          orderingHint: request.body.orderingHint,
        })
        .returning();
      if (!created) return reply.internalServerError('Failed to create activity.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'activity.slide_course_created',
        targetType: 'activity',
        targetId: created.id,
        payload: { trainingModuleId: module.id, slideDeckId: ctx.deck.id },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.send(created);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/content-pack-versions/:versionId/slide-decks
  //
  // Listing helper used by the "add slide-course activity" picker in the
  // training-module authoring UI. Returns only converted, ready decks so
  // authors can't link a still-failing render.
  // -------------------------------------------------------------------------
  app.get<{ Params: { versionId: string } }>(
    '/admin/content-pack-versions/:versionId/slide-decks',
    { schema: { params: z.object({ versionId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);

      // Find all slide-kind documents in the version, then join their decks.
      const docs = await db.query.documents.findMany({
        where: and(
          eq(schema.documents.contentPackVersionId, version.id),
          eq(schema.documents.kind, 'slides'),
        ),
        columns: { id: true, title: true },
        orderBy: [desc(schema.documents.createdAt)],
      });
      if (docs.length === 0) return reply.send([]);
      const out: Array<{
        slideDeckId: string;
        documentId: string;
        documentTitle: string;
        slideCount: number;
        conversionStatus: string;
      }> = [];
      for (const d of docs) {
        const deck = await db.query.slideDecks.findFirst({
          where: eq(schema.slideDecks.documentId, d.id),
          columns: {
            id: true,
            slideCount: true,
            conversionStatus: true,
          },
        });
        if (!deck) continue;
        out.push({
          slideDeckId: deck.id,
          documentId: d.id,
          documentTitle: d.title,
          slideCount: deck.slideCount,
          conversionStatus: deck.conversionStatus,
        });
      }
      return reply.send(out);
    },
  );
}
