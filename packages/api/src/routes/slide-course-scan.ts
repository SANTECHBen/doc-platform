// Public slide-course player API.
//
// Scan-session-authenticated (no Microsoft sign-in required). This is the
// path that runs when a tech scans a QR code on equipment and taps a
// slide-course activity in the Training tab — they get the authored deck,
// voiceover, and interactions, with answers graded server-side but not
// persisted. The "save my completion" flow is a separate, authenticated
// path that doesn't exist yet for the PWA; it'll fold back in when full
// PWA OIDC sign-in lands.
//
// Why a separate route set instead of relaxing the enrollment routes:
// the enrollment endpoints presuppose a `slide_attempts` row keyed by
// (enrollmentId, activityId), which presupposes a user. Scan-session
// callers have no user, so the data model doesn't fit. Cleaner to expose
// a parallel surface that returns the same shape sans attempt state.

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@platform/db';
import {
  UuidSchema,
  SlideInteractionAnswerSchema,
  SlideMcqConfigSchema,
  SlideTrueFalseConfigSchema,
  SlideDragMatchConfigSchema,
  SlideShortAnswerAiConfigSchema,
  SlideCourseActivityConfigSchema,
  type SlideInteractionAnswer,
} from '@platform/shared';
import {
  getEffectiveOrgScope,
  requireAuthOrScan,
} from '../middleware/scan-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LoadedActivityCtx {
  activity: typeof schema.activities.$inferSelect;
  module: typeof schema.trainingModules.$inferSelect;
  deck: typeof schema.slideDecks.$inferSelect;
}

async function loadActivityCtx(
  db: Database,
  activityId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<LoadedActivityCtx | null> {
  const activity = await db.query.activities.findFirst({
    where: eq(schema.activities.id, activityId),
  });
  if (!activity || activity.kind !== 'slide_course') return null;

  const module = await db.query.trainingModules.findFirst({
    where: eq(schema.trainingModules.id, activity.trainingModuleId),
    with: { packVersion: { with: { pack: true } } },
  });
  if (!module) return null;
  const ownerOrgId = (
    module as typeof module & {
      packVersion: { pack: { ownerOrganizationId: string } };
    }
  ).packVersion.pack.ownerOrganizationId;
  if (!scope.all && !scope.orgIds.includes(ownerOrgId)) return null;

  const cfgParse = SlideCourseActivityConfigSchema.safeParse(activity.config);
  if (!cfgParse.success) return null;
  const deck = await db.query.slideDecks.findFirst({
    where: eq(schema.slideDecks.id, cfgParse.data.slideDeckId),
  });
  if (!deck) return null;

  return { activity, module, deck };
}

// Strip server-only fields (correctIndex, correctAnswer, drag-match
// canonical pairing, AI grading rubric) so the player only sees what's
// needed to render. Right-side drag-match labels are shuffled
// deterministically per activity so they're stable on reload.
function sanitizeInteractionConfig(
  seedSalt: string,
  interactionId: string,
  kind: 'mcq' | 'true_false' | 'drag_match' | 'short_answer_ai',
  rawConfig: unknown,
): Record<string, unknown> {
  if (kind === 'mcq') {
    const c = SlideMcqConfigSchema.parse(rawConfig);
    return { options: c.options };
  }
  if (kind === 'true_false') {
    return {};
  }
  if (kind === 'drag_match') {
    const c = SlideDragMatchConfigSchema.parse(rawConfig);
    return {
      lefts: c.pairs.map((p) => p.left),
      rights: stableShuffle(
        `${seedSalt}:${interactionId}`,
        c.pairs.map((p) => p.right),
      ),
    };
  }
  const c = SlideShortAnswerAiConfigSchema.parse(rawConfig);
  return { passThreshold: c.passThreshold };
}

function stableShuffle<T>(seedStr: string, items: readonly T[]): T[] {
  let h = 0;
  for (let i = 0; i < seedStr.length; i += 1) {
    h = (h * 31 + seedStr.charCodeAt(i)) | 0;
  }
  let a = h >>> 0;
  function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

async function gradeInteraction(
  kind: 'mcq' | 'true_false' | 'drag_match' | 'short_answer_ai',
  rawConfig: unknown,
  answer: SlideInteractionAnswer,
  env: { OPENAI_API_KEY?: string | null },
): Promise<{
  isCorrect: boolean | null;
  score: number;
  rationale: string | null;
  passed: boolean;
}> {
  if (kind === 'mcq' && answer.kind === 'mcq') {
    const cfg = SlideMcqConfigSchema.parse(rawConfig);
    const ok = answer.answer.selectedIndex === cfg.correctIndex;
    return { isCorrect: ok, score: ok ? 1 : 0, rationale: null, passed: ok };
  }
  if (kind === 'true_false' && answer.kind === 'true_false') {
    const cfg = SlideTrueFalseConfigSchema.parse(rawConfig);
    const ok = answer.answer.answer === cfg.correctAnswer;
    return { isCorrect: ok, score: ok ? 1 : 0, rationale: null, passed: ok };
  }
  if (kind === 'drag_match' && answer.kind === 'drag_match') {
    const cfg = SlideDragMatchConfigSchema.parse(rawConfig);
    const totalPairs = cfg.pairs.length;
    let correctPairs = 0;
    for (const p of cfg.pairs) {
      if (answer.answer.mapping[p.left] === p.right) correctPairs += 1;
    }
    const score = totalPairs > 0 ? correctPairs / totalPairs : 0;
    return {
      isCorrect: correctPairs === totalPairs,
      score,
      rationale: null,
      passed: score >= 1,
    };
  }
  if (kind === 'short_answer_ai' && answer.kind === 'short_answer_ai') {
    const cfg = SlideShortAnswerAiConfigSchema.parse(rawConfig);
    if (!env.OPENAI_API_KEY) {
      return {
        isCorrect: null,
        score: 0,
        rationale: 'AI grading requires OPENAI_API_KEY on the server.',
        passed: false,
      };
    }
    const graded = await gradeShortAnswerAi(
      env.OPENAI_API_KEY,
      cfg.rubric,
      cfg.exampleAcceptable,
      answer.answer.text,
    );
    return {
      isCorrect: graded.score >= cfg.passThreshold,
      score: graded.score,
      rationale: graded.rationale,
      passed: graded.score >= cfg.passThreshold,
    };
  }
  throw new Error(
    `Answer kind "${answer.kind}" does not match interaction kind "${kind}".`,
  );
}

async function gradeShortAnswerAi(
  apiKey: string,
  rubric: string,
  examples: string[],
  learnerAnswer: string,
): Promise<{ score: number; rationale: string }> {
  const exampleBlock =
    examples.length > 0
      ? '\n\nExample acceptable answers:\n' + examples.map((e, i) => `${i + 1}. ${e}`).join('\n')
      : '';
  const prompt =
    `You are grading a short-answer training response.\n\n` +
    `RUBRIC:\n${rubric}${exampleBlock}\n\n` +
    `LEARNER ANSWER:\n${learnerAnswer}\n\n` +
    `Grade strictly against the rubric. Return JSON: {"score": 0..1, "rationale": "<one or two sentences>"}.`;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 200,
    }),
  });
  if (!resp.ok) {
    throw new Error(`AI grading failed: ${resp.status} ${await resp.text()}`);
  }
  const body = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = body.choices?.[0]?.message?.content ?? '';
  let parsed: { score?: number; rationale?: string };
  try {
    parsed = JSON.parse(content) as { score?: number; rationale?: string };
  } catch {
    throw new Error('AI grading returned non-JSON output');
  }
  const score =
    typeof parsed.score === 'number' && Number.isFinite(parsed.score)
      ? Math.max(0, Math.min(1, parsed.score))
      : 0;
  return {
    score,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const AnswerBody = z.object({
  interactionId: UuidSchema,
  answer: SlideInteractionAnswerSchema,
});

export async function registerSlideCourseScanRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /scan/activities/:activityId/slide-course
  //
  // Returns the player-facing deck: deck metadata, ordered slides with
  // sanitized interactions. No attempt persistence — the player tracks
  // its own progress client-side.
  // -------------------------------------------------------------------------
  app.get<{ Params: { activityId: string } }>(
    '/scan/activities/:activityId/slide-course',
    { schema: { params: z.object({ activityId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const ctx = await loadActivityCtx(db, request.params.activityId, scope);
      if (!ctx) return reply.notFound();

      const slides = await db.query.slideDeckSlides.findMany({
        where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
        orderBy: [
          asc(schema.slideDeckSlides.orderingHint),
          asc(schema.slideDeckSlides.slideIndex),
        ],
      });
      const interactions = slides.length
        ? await db.query.slideInteractions.findMany({
            where: inArray(
              schema.slideInteractions.slideId,
              slides.map((s) => s.id),
            ),
            orderBy: [asc(schema.slideInteractions.orderingHint)],
          })
        : [];

      const seedSalt = ctx.activity.id;
      const byInteractionList: Record<
        string,
        Array<{
          id: string;
          kind: typeof interactions[number]['kind'];
          prompt: string;
          weight: number;
          orderingHint: number;
          config: Record<string, unknown>;
        }>
      > = {};
      for (const i of interactions) {
        if (!byInteractionList[i.slideId]) byInteractionList[i.slideId] = [];
        byInteractionList[i.slideId]!.push({
          id: i.id,
          kind: i.kind,
          prompt: i.prompt,
          weight: i.weight,
          orderingHint: i.orderingHint,
          config: sanitizeInteractionConfig(seedSalt, i.id, i.kind, i.config),
        });
      }

      return reply.send({
        deck: {
          id: ctx.deck.id,
          slideCount: ctx.deck.slideCount,
          passThreshold: ctx.deck.passThreshold,
          conversionStatus: ctx.deck.conversionStatus,
          activityTitle: ctx.activity.title,
          moduleTitle: ctx.module.title,
        },
        slides: slides.map((s, i) => ({
          id: s.id,
          index: i,
          title: s.title,
          scriptMarkdown: s.scriptMarkdown,
          imageUrl: s.imageStorageKey ? storage.publicUrl(s.imageStorageKey) : null,
          imageWidth: s.imageWidth,
          imageHeight: s.imageHeight,
          voiceoverUrl: s.voiceoverStorageKey
            ? storage.publicUrl(s.voiceoverStorageKey)
            : null,
          voiceoverDurationSec: s.voiceoverDurationSec,
          navigationGate: s.navigationGate,
          // Content blocks for blank-slide authoring. Image blocks hold
          // a storageKey from the upload endpoint; we resolve to a URL
          // here so the player can render them without a second
          // round-trip.
          blocks: (s.blocks as unknown[]).map((block) => {
            const b = block as Record<string, unknown>;
            if (b.kind === 'image' && typeof b.storageKey === 'string') {
              return { ...b, url: storage.publicUrl(b.storageKey) };
            }
            if (b.kind === 'video_file' && typeof b.storageKey === 'string') {
              return { ...b, url: storage.publicUrl(b.storageKey) };
            }
            return b;
          }),
          interactions: byInteractionList[s.id] ?? [],
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /scan/activities/:activityId/slide-course/grade
  //
  // Grade a single interaction and return the result. No persistence.
  // The player accumulates results client-side and shows a final summary
  // at the end of the deck.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { activityId: string };
    Body: z.infer<typeof AnswerBody>;
  }>(
    '/scan/activities/:activityId/slide-course/grade',
    {
      schema: {
        params: z.object({ activityId: UuidSchema }),
        body: AnswerBody,
      },
    },
    async (request, reply) => {
      const { db, env } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const ctx = await loadActivityCtx(db, request.params.activityId, scope);
      if (!ctx) return reply.notFound();

      const interaction = await db.query.slideInteractions.findFirst({
        where: eq(schema.slideInteractions.id, request.body.interactionId),
      });
      if (!interaction) return reply.notFound('Interaction not found.');

      // The interaction must belong to a slide on this deck — otherwise a
      // caller could grade against another deck's correct answer.
      const slide = await db.query.slideDeckSlides.findFirst({
        where: and(
          eq(schema.slideDeckSlides.id, interaction.slideId),
          eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
        ),
      });
      if (!slide) return reply.notFound('Interaction does not belong to this deck.');

      let graded;
      try {
        graded = await gradeInteraction(
          interaction.kind,
          interaction.config,
          request.body.answer,
          env,
        );
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : 'Grading failed.');
      }

      const reveal: Record<string, unknown> = {};
      if (interaction.kind === 'mcq') {
        const cfg = SlideMcqConfigSchema.parse(interaction.config);
        reveal.correctIndex = cfg.correctIndex;
        if (cfg.explanation) reveal.explanation = cfg.explanation;
      } else if (interaction.kind === 'true_false') {
        const cfg = SlideTrueFalseConfigSchema.parse(interaction.config);
        reveal.correctAnswer = cfg.correctAnswer;
        if (cfg.explanation) reveal.explanation = cfg.explanation;
      } else if (interaction.kind === 'drag_match') {
        const cfg = SlideDragMatchConfigSchema.parse(interaction.config);
        reveal.correctMapping = Object.fromEntries(
          cfg.pairs.map((p) => [p.left, p.right]),
        );
      } else {
        reveal.rationale = graded.rationale;
      }

      return reply.send({
        interactionId: interaction.id,
        isCorrect: graded.isCorrect,
        score: graded.score,
        passed: graded.passed,
        rationale: graded.rationale,
        reveal,
      });
    },
  );
}
