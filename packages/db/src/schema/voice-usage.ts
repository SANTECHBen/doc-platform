import { pgTable, uuid, text, timestamp, integer, numeric, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { users } from './users';
import { assetInstances } from './assets';

// Per-call voice usage log. Every STT, TTS, and verifier API call writes
// one row here so we can:
//   1. Enforce per-org daily/monthly quotas (sum & count over time windows).
//   2. Bill or charge overages.
//   3. Audit which org/user/asset drove cost spikes.
//   4. Fire spend alarms when an org crosses its alert threshold.
//
// Cost is stored as numeric(12,4) cents — i.e. 0.0001 cent precision —
// because TTS pricing is in fractional cents per char and we don't want
// rounding to mask spike behavior. Sum aggregates against this column at
// quota-check time.
export const voiceUsage = pgTable(
  'voice_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Optional: the signed-in user that drove the call. Null when the call
    // came in via a scan-session (anonymous QR-scoped traffic).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Optional: the asset whose hub the tech was on. Lets us trace cost
    // back to specific equipment ("which asset is hammering voice?").
    assetInstanceId: uuid('asset_instance_id').references(
      () => assetInstances.id,
      { onDelete: 'set null' },
    ),
    // 'stt'    — Whisper transcription (one tech utterance)
    // 'tts'    — OpenAI TTS synthesis (one assistant answer or preflight greet)
    // 'verify' — Anthropic Haiku verifier pass (after a chat turn)
    kind: text('kind').notNull(),
    // Units appropriate to the kind:
    //   stt    → seconds of audio (ceil)
    //   tts    → characters synthesized
    //   verify → input tokens + output tokens (sum)
    units: integer('units').notNull(),
    // Cost of this single call in US cents (numeric for precision).
    costCents: numeric('cost_cents', { precision: 12, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Composite index drives the hot path: "sum cost / count rows for org X
    // since timestamp Y". Postgres will index-only-scan this when the cost
    // sum is the only column being aggregated.
    orgCreatedIdx: index('voice_usage_org_created_idx').on(
      t.organizationId,
      t.createdAt,
    ),
    kindIdx: index('voice_usage_kind_idx').on(t.kind),
  }),
);

export const voiceUsageRelations = relations(voiceUsage, ({ one }) => ({
  organization: one(organizations, {
    fields: [voiceUsage.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [voiceUsage.userId],
    references: [users.id],
  }),
  assetInstance: one(assetInstances, {
    fields: [voiceUsage.assetInstanceId],
    references: [assetInstances.id],
  }),
}));

export type VoiceUsage = typeof voiceUsage.$inferSelect;
export type NewVoiceUsage = typeof voiceUsage.$inferInsert;

// Voice quota config attached to organizations.voice_quota (jsonb). null =
// use the default tier ('standard'). Inline shape keeps the org row small
// and lets us roll out new dimensions without a migration each time.
export interface VoiceQuotaConfig {
  // Pre-baked tier the org is on. 'custom' = caps overridden ad-hoc.
  tier: 'free' | 'standard' | 'pro' | 'enterprise' | 'custom';
  // Hard caps. null = unlimited. The first violated cap returns 429.
  dailyTurnsCap: number | null;
  monthlyTtsCharCap: number | null;
  monthlyDollarCap: number | null;
  // Soft alarm — when exceeded, fire a Slack ping but don't block.
  alertDailyDollarThreshold: number | null;
}
