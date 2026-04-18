import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { contentPackVersions } from './content';
import { users } from './users';
import { assetInstances } from './assets';
import { activityKindEnum, enrollmentStatusEnum } from './enums';

export const trainingModules = pgTable('training_modules', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentPackVersionId: uuid('content_pack_version_id')
    .notNull()
    .references(() => contentPackVersions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  estimatedMinutes: integer('estimated_minutes'),
  // Target competency tag this module certifies (e.g., "mhe.operator.forklift.class-1").
  competencyTag: text('competency_tag'),
  orderingHint: integer('ordering_hint').notNull().default(0),
  // Pass threshold (0..1). Aggregate score across activities.
  passThreshold: real('pass_threshold').notNull().default(0.8),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const lessons = pgTable('lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  trainingModuleId: uuid('training_module_id')
    .notNull()
    .references(() => trainingModules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  bodyMarkdown: text('body_markdown'),
  streamPlaybackId: text('stream_playback_id'),
  orderingHint: integer('ordering_hint').notNull().default(0),
});

// Activity is the assessable unit. The `config` shape varies by kind:
//   quiz                   → { questions: [{prompt, options, correctIndex, explanation}] }
//   checklist              → { items: [{text, required}] }
//   procedure_signoff      → { steps: [{text, requiresSignature}] }
//   video_knowledge_check  → { videoStreamId, questions: [...], gateSeconds }
//   practical              → { rubric: [...], requiresInstructor: true }
export const activities = pgTable('activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  trainingModuleId: uuid('training_module_id')
    .notNull()
    .references(() => trainingModules.id, { onDelete: 'cascade' }),
  kind: activityKindEnum('kind').notNull(),
  title: text('title').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  weight: real('weight').notNull().default(1),
  orderingHint: integer('ordering_hint').notNull().default(0),
});

export const enrollments = pgTable(
  'enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trainingModuleId: uuid('training_module_id')
      .notNull()
      .references(() => trainingModules.id, { onDelete: 'cascade' }),
    // Optional: the specific asset instance the user was on when enrolled.
    // Helpful for on-the-job training flow triggered by a QR scan.
    assetInstanceId: uuid('asset_instance_id').references(() => assetInstances.id, {
      onDelete: 'set null',
    }),
    status: enrollmentStatusEnum('status').notNull().default('not_started'),
    score: real('score'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserModule: unique().on(t.userId, t.trainingModuleId),
    userIdx: index('enrollments_user_idx').on(t.userId),
  }),
);

// ActivityResult is the per-activity grade record within an Enrollment.
export const activityResults = pgTable('activity_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  enrollmentId: uuid('enrollment_id')
    .notNull()
    .references(() => enrollments.id, { onDelete: 'cascade' }),
  activityId: uuid('activity_id')
    .notNull()
    .references(() => activities.id, { onDelete: 'cascade' }),
  score: real('score').notNull(),
  passed: text('passed'),
  submission: jsonb('submission').$type<Record<string, unknown>>().notNull().default({}),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
});

export const trainingModulesRelations = relations(trainingModules, ({ one, many }) => ({
  packVersion: one(contentPackVersions, {
    fields: [trainingModules.contentPackVersionId],
    references: [contentPackVersions.id],
  }),
  lessons: many(lessons),
  activities: many(activities),
}));

export const lessonsRelations = relations(lessons, ({ one }) => ({
  module: one(trainingModules, {
    fields: [lessons.trainingModuleId],
    references: [trainingModules.id],
  }),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  module: one(trainingModules, {
    fields: [activities.trainingModuleId],
    references: [trainingModules.id],
  }),
}));

export const enrollmentsRelations = relations(enrollments, ({ one, many }) => ({
  user: one(users, { fields: [enrollments.userId], references: [users.id] }),
  module: one(trainingModules, {
    fields: [enrollments.trainingModuleId],
    references: [trainingModules.id],
  }),
  results: many(activityResults),
}));

export type TrainingModule = typeof trainingModules.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type ActivityResult = typeof activityResults.$inferSelect;
