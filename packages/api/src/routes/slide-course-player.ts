// Learner-facing slide-course player API.
//
// Lives under /enrollments/:id/slide-course/... and is gated on auth +
// enrollment ownership. Mirrors the existing /enrollments/:id/submit-quiz
// scoring shape so the aggregation logic in training.ts and this file
// both terminate in activity_results rows the same way.
//
// What the player gets back is intentionally sanitized — the server
// never sends the correctIndex, correctAnswer, drag-match right-side
// labels in their original order, or the rubric. That stays on the
// server so a determined learner with browser devtools still has to
// answer to know if they're right.

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
import { requireAuth } from '../middleware/auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadEnrollment(
  db: Database,
  enrollmentId: string,
  userId: string,
) {
  return db.query.enrollments.findFirst({
    where: and(
      eq(schema.enrollments.id, enrollmentId),
      eq(schema.enrollments.userId, userId),
    ),
  });
}

async function loadSlideCourseContext(
  db: Database,
  enrollmentId: string,
  userId: string,
  activityId: string,
) {
  const enrollment = await loadEnrollment(db, enrollmentId, userId);
  if (!enrollment) return null;
  const activity = await db.query.activities.findFirst({
    where: and(
      eq(schema.activities.id, activityId),
      eq(schema.activities.trainingModuleId, enrollment.trainingModuleId),
    ),
  });
  if (!activity || activity.kind !== 'slide_course') return null;
  const cfgParse = SlideCourseActivityConfigSchema.safeParse(activity.config);
  if (!cfgParse.success) return null;
  const deck = await db.query.slideDecks.findFirst({
    where: eq(schema.slideDecks.id, cfgParse.data.slideDeckId),
  });
  if (!deck) return null;
  return { enrollment, activity, deck };
}

async function ensureAttempt(
  db: Database,
  enrollmentId: string,
  activityId: string,
) {
  const existing = await db.query.slideAttempts.findFirst({
    where: and(
      eq(schema.slideAttempts.enrollmentId, enrollmentId),
      eq(schema.slideAttempts.activityId, activityId),
    ),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(schema.slideAttempts)
    .values({
      enrollmentId,
      activityId,
      currentSlideIndex: 0,
      status: 'in_progress',
    })
    .returning();
  if (!created) throw new Error('Failed to create slide attempt.');
  return created;
}

// Stable shuffle so the player always sees the same order of right-side
// labels for a given (attempt, interaction) — otherwise a learner could
// keep refreshing until the labels align with the order they remember.
// Mulberry32 PRNG seeded from a small hash of (attemptId, interactionId).
function stableShuffle<T>(seedStr: string, items: readonly T[]): T[] {
  let h = 0;
  for (let i = 0; i < seedStr.length; i += 1) {
    h = (h * 31 + seedStr.charCodeAt(i)) | 0;
  }
  // Mulberry32
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

// Build the sanitized config the learner sees. Includes only what's
// needed to render the interaction — never the correct answer.
function sanitizeInteractionConfig(
  attemptId: string,
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
      // Right-side values are shuffled deterministically per attempt so
      // the order is stable on reload but unrelated to the correct
      // pairing index.
      rights: stableShuffle(
        `${attemptId}:${interactionId}`,
        c.pairs.map((p) => p.right),
      ),
    };
  }
  // short_answer_ai — strip the rubric. Player only needs the prompt
  // (which lives on the interaction row, not in config).
  const c = SlideShortAnswerAiConfigSchema.parse(rawConfig);
  return { passThreshold: c.passThreshold };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

interface GradeResult {
  isCorrect: boolean | null;
  score: number;
  rationale: string | null;
  passed: boolean;
}

async function gradeInteraction(
  interactionKind: 'mcq' | 'true_false' | 'drag_match' | 'short_answer_ai',
  rawConfig: unknown,
  answer: SlideInteractionAnswer,
  env: { OPENAI_API_KEY?: string | null; OPENAI_TTS_MODEL?: string | null },
): Promise<GradeResult> {
  if (interactionKind === 'mcq' && answer.kind === 'mcq') {
    const cfg = SlideMcqConfigSchema.parse(rawConfig);
    const ok = answer.answer.selectedIndex === cfg.correctIndex;
    return { isCorrect: ok, score: ok ? 1 : 0, rationale: null, passed: ok };
  }
  if (interactionKind === 'true_false' && answer.kind === 'true_false') {
    const cfg = SlideTrueFalseConfigSchema.parse(rawConfig);
    const ok = answer.answer.answer === cfg.correctAnswer;
    return { isCorrect: ok, score: ok ? 1 : 0, rationale: null, passed: ok };
  }
  if (interactionKind === 'drag_match' && answer.kind === 'drag_match') {
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
  if (interactionKind === 'short_answer_ai' && answer.kind === 'short_answer_ai') {
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
  // Mismatched kind → reject.
  throw new Error(
    `Answer kind "${answer.kind}" does not match interaction kind "${interactionKind}".`,
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
    `Grade strictly against the rubric. Return JSON with this exact shape:\n` +
    `{"score": <0..1 number>, "rationale": "<one or two sentences>"}\n` +
    `score 1.0 = fully meets the rubric. 0.0 = does not address the rubric at all.`;
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
  const score = typeof parsed.score === 'number' ? clamp01(parsed.score) : 0;
  return {
    score,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Aggregation: roll a finished slide attempt into activity_results +
// re-aggregate enrollment.score / status. Mirrors the logic in
// training.ts:submit-quiz so behavior stays consistent across activity
// kinds.
// ---------------------------------------------------------------------------

async function rollAttemptIntoEnrollment(
  db: Database,
  enrollmentId: string,
  activityId: string,
  attemptScore: number,
  attemptPassed: boolean,
  attemptSubmission: Record<string, unknown>,
): Promise<{ status: string; score: number }> {
  // Upsert activityResults: only one row per (enrollment, activity);
  // resubmits overwrite.
  const existing = await db.query.activityResults.findFirst({
    where: and(
      eq(schema.activityResults.enrollmentId, enrollmentId),
      eq(schema.activityResults.activityId, activityId),
    ),
  });
  if (existing) {
    await db
      .update(schema.activityResults)
      .set({
        score: attemptScore,
        passed: attemptPassed ? 'true' : 'false',
        submission: attemptSubmission,
        submittedAt: new Date(),
      })
      .where(eq(schema.activityResults.id, existing.id));
  } else {
    await db.insert(schema.activityResults).values({
      enrollmentId,
      activityId,
      score: attemptScore,
      passed: attemptPassed ? 'true' : 'false',
      submission: attemptSubmission,
    });
  }

  const enrollment = await db.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, enrollmentId),
  });
  if (!enrollment) throw new Error('enrollment missing after activity submit');
  const moduleActivities = await db.query.activities.findMany({
    where: eq(schema.activities.trainingModuleId, enrollment.trainingModuleId),
  });
  const allResults = await db.query.activityResults.findMany({
    where: eq(schema.activityResults.enrollmentId, enrollmentId),
  });
  const bestByActivity = new Map<string, number>();
  for (const r of allResults) {
    const prev = bestByActivity.get(r.activityId);
    if (prev === undefined || r.score > prev) bestByActivity.set(r.activityId, r.score);
  }
  let totalWeight = 0;
  let weightedScore = 0;
  for (const a of moduleActivities) {
    totalWeight += a.weight;
    weightedScore += (bestByActivity.get(a.id) ?? 0) * a.weight;
  }
  const aggregate = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const allSubmitted = moduleActivities.every((a) => bestByActivity.has(a.id));
  const module = await db.query.trainingModules.findFirst({
    where: eq(schema.trainingModules.id, enrollment.trainingModuleId),
  });
  const passThreshold = module?.passThreshold ?? 0.8;
  const now = new Date();
  const newStatus = allSubmitted
    ? aggregate >= passThreshold
      ? ('completed' as const)
      : ('failed' as const)
    : ('in_progress' as const);
  await db
    .update(schema.enrollments)
    .set({
      score: aggregate,
      status: newStatus,
      completedAt:
        newStatus === 'completed' || newStatus === 'failed'
          ? now
          : enrollment.completedAt,
    })
    .where(eq(schema.enrollments.id, enrollmentId));
  return { status: newStatus, score: aggregate };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ActivityQuery = z.object({ activityId: UuidSchema });
const ProgressBody = z.object({
  activityId: UuidSchema,
  currentSlideIndex: z.number().int().min(0).max(10_000),
});
const AnswerBody = z.object({
  activityId: UuidSchema,
  interactionId: UuidSchema,
  answer: SlideInteractionAnswerSchema,
});
const SubmitBody = z.object({ activityId: UuidSchema });

export async function registerSlideCoursePlayerRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /enrollments/:id/slide-course?activityId=...
  //
  // Returns the deck + slides + sanitized interactions + the caller's
  // attempt state (currentSlideIndex + prior answers so the player can
  // rehydrate after a reload).
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { activityId: string } }>(
    '/enrollments/:id/slide-course',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        querystring: ActivityQuery,
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadSlideCourseContext(
        db,
        request.params.id,
        auth.userId,
        request.query.activityId,
      );
      if (!ctx) return reply.notFound();
      const attempt = await ensureAttempt(db, ctx.enrollment.id, ctx.activity.id);

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

      // Drop the in-flight onPickSession-like start: mark enrollment
      // in_progress if it was not_started.
      if (ctx.enrollment.status === 'not_started') {
        await db
          .update(schema.enrollments)
          .set({ status: 'in_progress', startedAt: new Date() })
          .where(eq(schema.enrollments.id, ctx.enrollment.id));
      }

      const priorAnswers = await db.query.slideAttemptAnswers.findMany({
        where: eq(schema.slideAttemptAnswers.slideAttemptId, attempt.id),
      });
      const priorByInteraction = new Map(priorAnswers.map((a) => [a.interactionId, a]));

      const byInteractionList: Record<string, ReturnType<typeof toLearnerInteraction>[]> = {};
      for (const i of interactions) {
        if (!byInteractionList[i.slideId]) byInteractionList[i.slideId] = [];
        const prior = priorByInteraction.get(i.id);
        byInteractionList[i.slideId]!.push(
          toLearnerInteraction(i, attempt.id, prior),
        );
      }

      return reply.send({
        deck: {
          id: ctx.deck.id,
          slideCount: ctx.deck.slideCount,
          passThreshold: ctx.deck.passThreshold,
          conversionStatus: ctx.deck.conversionStatus,
        },
        attempt: {
          id: attempt.id,
          currentSlideIndex: attempt.currentSlideIndex,
          status: attempt.status,
          totalScore: attempt.totalScore,
        },
        slides: slides.map((s, i) => ({
          id: s.id,
          index: i, // play-order index (post orderingHint sort)
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
          interactions: byInteractionList[s.id] ?? [],
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /enrollments/:id/slide-course/progress
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof ProgressBody>;
  }>(
    '/enrollments/:id/slide-course/progress',
    { schema: { params: z.object({ id: UuidSchema }), body: ProgressBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadSlideCourseContext(
        db,
        request.params.id,
        auth.userId,
        request.body.activityId,
      );
      if (!ctx) return reply.notFound();
      const attempt = await ensureAttempt(db, ctx.enrollment.id, ctx.activity.id);
      await db
        .update(schema.slideAttempts)
        .set({
          currentSlideIndex: request.body.currentSlideIndex,
          lastActivityAt: new Date(),
        })
        .where(eq(schema.slideAttempts.id, attempt.id));
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /enrollments/:id/slide-course/answer
  //
  // Grades a single interaction and upserts the answer row. Returns the
  // graded result so the player can show feedback immediately. The
  // sanitized correct answer (or "not yet" for AI rationale) is also
  // returned so the player can reveal it inline.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof AnswerBody>;
  }>(
    '/enrollments/:id/slide-course/answer',
    { schema: { params: z.object({ id: UuidSchema }), body: AnswerBody } },
    async (request, reply) => {
      const { db, env } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadSlideCourseContext(
        db,
        request.params.id,
        auth.userId,
        request.body.activityId,
      );
      if (!ctx) return reply.notFound();
      const attempt = await ensureAttempt(db, ctx.enrollment.id, ctx.activity.id);

      const interaction = await db.query.slideInteractions.findFirst({
        where: eq(schema.slideInteractions.id, request.body.interactionId),
      });
      if (!interaction) return reply.notFound('Interaction not found.');

      // Make sure the interaction lives under this deck.
      const slide = await db.query.slideDeckSlides.findFirst({
        where: and(
          eq(schema.slideDeckSlides.id, interaction.slideId),
          eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
        ),
      });
      if (!slide) return reply.notFound('Interaction does not belong to this deck.');

      let graded: GradeResult;
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

      // Upsert the answer.
      const existing = await db.query.slideAttemptAnswers.findFirst({
        where: and(
          eq(schema.slideAttemptAnswers.slideAttemptId, attempt.id),
          eq(schema.slideAttemptAnswers.interactionId, interaction.id),
        ),
      });
      if (existing) {
        await db
          .update(schema.slideAttemptAnswers)
          .set({
            answer: request.body.answer.answer,
            isCorrect: graded.isCorrect,
            score: graded.score,
            aiGradeRationale: graded.rationale,
            answeredAt: new Date(),
          })
          .where(eq(schema.slideAttemptAnswers.id, existing.id));
      } else {
        await db.insert(schema.slideAttemptAnswers).values({
          slideAttemptId: attempt.id,
          interactionId: interaction.id,
          answer: request.body.answer.answer,
          isCorrect: graded.isCorrect,
          score: graded.score,
          aiGradeRationale: graded.rationale,
        });
      }
      await db
        .update(schema.slideAttempts)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.slideAttempts.id, attempt.id));

      // What we send back to the player. We include the correct answer
      // ONLY for deterministic kinds — for short_answer_ai the rationale
      // is the explanation; there is no single canonical "correct".
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

  // -------------------------------------------------------------------------
  // POST /enrollments/:id/slide-course/submit
  //
  // Closes the attempt: aggregate weighted score across all interactions,
  // flip status to passed/failed, write activity_results, roll the
  // enrollment score the same way submit-quiz does.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: z.infer<typeof SubmitBody>;
  }>(
    '/enrollments/:id/slide-course/submit',
    { schema: { params: z.object({ id: UuidSchema }), body: SubmitBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const ctx = await loadSlideCourseContext(
        db,
        request.params.id,
        auth.userId,
        request.body.activityId,
      );
      if (!ctx) return reply.notFound();
      const attempt = await ensureAttempt(db, ctx.enrollment.id, ctx.activity.id);

      // Fetch the interactions + answers, weight & average.
      const slides = await db.query.slideDeckSlides.findMany({
        where: eq(schema.slideDeckSlides.slideDeckId, ctx.deck.id),
        columns: { id: true },
      });
      const interactions = slides.length
        ? await db.query.slideInteractions.findMany({
            where: inArray(
              schema.slideInteractions.slideId,
              slides.map((s) => s.id),
            ),
          })
        : [];
      const answers = await db.query.slideAttemptAnswers.findMany({
        where: eq(schema.slideAttemptAnswers.slideAttemptId, attempt.id),
      });
      const byInteraction = new Map(answers.map((a) => [a.interactionId, a]));

      let totalWeight = 0;
      let weighted = 0;
      for (const i of interactions) {
        totalWeight += i.weight;
        const a = byInteraction.get(i.id);
        const s = a?.score ?? 0;
        weighted += s * i.weight;
      }
      const attemptScore = totalWeight > 0 ? weighted / totalWeight : 0;
      const passed = attemptScore >= ctx.deck.passThreshold;

      await db
        .update(schema.slideAttempts)
        .set({
          status: passed ? 'passed' : 'failed',
          totalScore: attemptScore,
          submittedAt: new Date(),
        })
        .where(eq(schema.slideAttempts.id, attempt.id));

      const rollup = await rollAttemptIntoEnrollment(
        db,
        ctx.enrollment.id,
        ctx.activity.id,
        attemptScore,
        passed,
        {
          attemptId: attempt.id,
          interactionScores: Array.from(byInteraction.values()).map((a) => ({
            interactionId: a.interactionId,
            score: a.score,
            isCorrect: a.isCorrect,
          })),
        },
      );

      return reply.send({
        attemptScore,
        passed,
        passThreshold: ctx.deck.passThreshold,
        interactionsCount: interactions.length,
        answeredCount: byInteraction.size,
        enrollmentStatus: rollup.status,
        enrollmentScore: rollup.score,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Small helper to convert a server interaction row → the learner DTO,
// with sanitized config and any prior answer attached.
// ---------------------------------------------------------------------------

function toLearnerInteraction(
  row: typeof schema.slideInteractions.$inferSelect,
  attemptId: string,
  prior:
    | typeof schema.slideAttemptAnswers.$inferSelect
    | undefined,
): {
  id: string;
  kind: typeof row.kind;
  prompt: string;
  weight: number;
  orderingHint: number;
  config: Record<string, unknown>;
  prior:
    | {
        answer: unknown;
        isCorrect: boolean | null;
        score: number | null;
        rationale: string | null;
        answeredAt: string;
      }
    | null;
} {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    weight: row.weight,
    orderingHint: row.orderingHint,
    config: sanitizeInteractionConfig(attemptId, row.id, row.kind, row.config),
    prior: prior
      ? {
          answer: prior.answer,
          isCorrect: prior.isCorrect,
          score: prior.score,
          rationale: prior.aiGradeRationale,
          answeredAt: prior.answeredAt.toISOString(),
        }
      : null,
  };
}

