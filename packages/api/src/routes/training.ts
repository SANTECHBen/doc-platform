import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema, QuizConfigSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';

export async function registerTrainingRoutes(app: FastifyInstance) {
  // List modules in a content-pack version, with compact lesson/activity counts
  // and the caller's enrollment state if they're authenticated.
  app.get<{ Params: { versionId: string } }>(
    '/content-pack-versions/:versionId/training-modules',
    { schema: { params: z.object({ versionId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      const modules = await db.query.trainingModules.findMany({
        where: eq(schema.trainingModules.contentPackVersionId, request.params.versionId),
      });
      if (modules.length === 0) return [];

      const moduleIds = modules.map((m) => m.id);
      const activities = await db.query.activities.findMany({
        where: inArray(schema.activities.trainingModuleId, moduleIds),
      });
      const lessons = await db.query.lessons.findMany({
        where: inArray(schema.lessons.trainingModuleId, moduleIds),
      });
      const countsByModule = new Map<
        string,
        { activityCount: number; lessonCount: number }
      >();
      for (const m of modules) {
        countsByModule.set(m.id, { activityCount: 0, lessonCount: 0 });
      }
      for (const a of activities) {
        const c = countsByModule.get(a.trainingModuleId);
        if (c) c.activityCount += 1;
      }
      for (const l of lessons) {
        const c = countsByModule.get(l.trainingModuleId);
        if (c) c.lessonCount += 1;
      }

      // Enrollment state per module for the caller, if any.
      let enrollmentByModule = new Map<
        string,
        { id: string; status: string; score: number | null }
      >();
      if (request.auth) {
        const enrollments = await db.query.enrollments.findMany({
          where: and(
            eq(schema.enrollments.userId, request.auth.userId),
            inArray(schema.enrollments.trainingModuleId, moduleIds),
          ),
        });
        enrollmentByModule = new Map(
          enrollments.map((e) => [
            e.trainingModuleId,
            { id: e.id, status: e.status, score: e.score },
          ]),
        );
      }

      return modules
        .sort((a, b) => a.orderingHint - b.orderingHint)
        .map((m) => ({
          id: m.id,
          title: m.title,
          description: m.description,
          estimatedMinutes: m.estimatedMinutes,
          competencyTag: m.competencyTag,
          passThreshold: m.passThreshold,
          lessonCount: countsByModule.get(m.id)?.lessonCount ?? 0,
          activityCount: countsByModule.get(m.id)?.activityCount ?? 0,
          enrollment: enrollmentByModule.get(m.id) ?? null,
        }));
    },
  );

  // Full module detail with lessons and activity configs (for rendering a runner).
  app.get<{ Params: { id: string } }>(
    '/training-modules/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const mod = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.id),
        with: {
          lessons: true,
          activities: true,
        },
      });
      if (!mod) return reply.notFound();
      return {
        id: mod.id,
        title: mod.title,
        description: mod.description,
        estimatedMinutes: mod.estimatedMinutes,
        passThreshold: mod.passThreshold,
        lessons: [...mod.lessons].sort((a, b) => a.orderingHint - b.orderingHint),
        activities: [...mod.activities].sort((a, b) => a.orderingHint - b.orderingHint),
      };
    },
  );

  // Create or return an enrollment for the caller on a specific module,
  // optionally anchored to the asset instance they were on when they started
  // (useful for QR-triggered on-the-job training).
  app.post<{ Body: { trainingModuleId: string; assetInstanceId?: string } }>(
    '/enrollments',
    {
      schema: {
        body: z.object({
          trainingModuleId: UuidSchema,
          assetInstanceId: UuidSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);

      const now = new Date();
      // Insert-or-ignore pattern: two concurrent calls (common under React
      // Strict Mode's double-fired effects) must not throw on the unique
      // (userId, trainingModuleId) constraint. If the row already exists,
      // re-fetch and return it.
      const [created] = await db
        .insert(schema.enrollments)
        .values({
          userId: auth.userId,
          trainingModuleId: request.body.trainingModuleId,
          assetInstanceId: request.body.assetInstanceId ?? null,
          status: 'in_progress',
          startedAt: now,
        })
        .onConflictDoNothing({
          target: [schema.enrollments.userId, schema.enrollments.trainingModuleId],
        })
        .returning();
      if (created) return created;

      const existing = await db.query.enrollments.findFirst({
        where: and(
          eq(schema.enrollments.userId, auth.userId),
          eq(schema.enrollments.trainingModuleId, request.body.trainingModuleId),
        ),
      });
      if (!existing) return reply.internalServerError('Failed to create or fetch enrollment.');
      return existing;
    },
  );

  // Submit an entire quiz in one shot. Scores it server-side, writes activity
  // results, and updates the enrollment's aggregate score + completion status.
  //
  // Supporting one-shot submission for quizzes only in Phase 1; per-step
  // procedure_signoff and practical submissions come later.
  app.post<{
    Params: { id: string };
    Body: { activityId: string; answers: number[] };
  }>(
    '/enrollments/:id/submit-quiz',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          activityId: UuidSchema,
          answers: z.array(z.number().int().nonnegative()).min(1),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);

      const enrollment = await db.query.enrollments.findFirst({
        where: and(
          eq(schema.enrollments.id, request.params.id),
          eq(schema.enrollments.userId, auth.userId),
        ),
      });
      if (!enrollment) return reply.notFound();

      const activity = await db.query.activities.findFirst({
        where: and(
          eq(schema.activities.id, request.body.activityId),
          eq(schema.activities.trainingModuleId, enrollment.trainingModuleId),
        ),
      });
      if (!activity) return reply.notFound('Activity not found in this module.');
      if (activity.kind !== 'quiz') {
        return reply.badRequest('This endpoint only handles quiz activities.');
      }

      // Validate the quiz config structurally before scoring.
      const parsed = QuizConfigSchema.safeParse(activity.config);
      if (!parsed.success) {
        return reply.internalServerError('Activity config is malformed.');
      }
      const questions = parsed.data.questions;
      if (request.body.answers.length !== questions.length) {
        return reply.badRequest(
          `Expected ${questions.length} answers, got ${request.body.answers.length}.`,
        );
      }

      let correct = 0;
      const perQuestion = questions.map((q, i) => {
        const ans = request.body.answers[i] ?? -1;
        const isCorrect = ans === q.correctIndex;
        if (isCorrect) correct += 1;
        return {
          questionIndex: i,
          chosenIndex: ans,
          correctIndex: q.correctIndex,
          correct: isCorrect,
        };
      });
      const activityScore = correct / questions.length;

      await db.insert(schema.activityResults).values({
        enrollmentId: enrollment.id,
        activityId: activity.id,
        score: activityScore,
        passed: activityScore >= 0.5 ? 'true' : 'false',
        submission: { answers: request.body.answers, perQuestion },
      });

      // Re-aggregate enrollment score across all activities in this module.
      const moduleActivities = await db.query.activities.findMany({
        where: eq(schema.activities.trainingModuleId, enrollment.trainingModuleId),
      });
      const allResults = await db.query.activityResults.findMany({
        where: eq(schema.activityResults.enrollmentId, enrollment.id),
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
          ? 'completed'
          : 'failed'
        : 'in_progress';

      const [updated] = await db
        .update(schema.enrollments)
        .set({
          score: aggregate,
          status: newStatus,
          completedAt:
            newStatus === 'completed' || newStatus === 'failed' ? now : enrollment.completedAt,
        })
        .where(eq(schema.enrollments.id, enrollment.id))
        .returning();

      return {
        activityScore,
        correct,
        total: questions.length,
        perQuestion,
        enrollment: updated,
      };
    },
  );
}
