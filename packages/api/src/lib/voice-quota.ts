import { sql } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import type { VoiceQuotaConfig } from '@platform/db';

// =============================================================================
// Pricing — cents per unit
// =============================================================================
//
// All cost math runs in US cents to avoid float drift. Numbers below are the
// platform's published vendor pricing as of project start; if vendors change
// pricing, update here — every consumer reads through these constants.

export const PRICING = {
  // Whisper-1: $0.006 / minute → 0.01 cents / second
  whisperPerSecondCents: 0.01,
  // TTS-1:    $15 / 1M chars → 0.0015 cents / char
  // TTS-1-HD: $30 / 1M chars → 0.003  cents / char
  tts1PerCharCents: 0.0015,
  tts1HdPerCharCents: 0.003,
  // Haiku 4.5: $1/Mtok input, $5/Mtok output → 0.0001 / 0.0005 cents per token
  haikuInputPerTokenCents: 0.0001,
  haikuOutputPerTokenCents: 0.0005,
} as const;

export function computeSttCostCents(seconds: number): number {
  return Math.max(0, seconds) * PRICING.whisperPerSecondCents;
}

export function computeTtsCostCents(chars: number, model: string): number {
  const perChar = model.toLowerCase().includes('hd')
    ? PRICING.tts1HdPerCharCents
    : PRICING.tts1PerCharCents;
  return Math.max(0, chars) * perChar;
}

export function computeVerifyCostCents(input: { inputTokens: number; outputTokens: number }): number {
  return (
    input.inputTokens * PRICING.haikuInputPerTokenCents +
    input.outputTokens * PRICING.haikuOutputPerTokenCents
  );
}

// =============================================================================
// Tier defaults
// =============================================================================
//
// New orgs default to 'standard' — generous enough that a real customer's
// daily use never bumps the cap, tight enough that a bug or scripted abuse
// can't cost you four figures before alarms fire.

export const TIER_DEFAULTS: Record<
  Exclude<VoiceQuotaConfig['tier'], 'custom'>,
  Omit<VoiceQuotaConfig, 'tier'>
> = {
  free: {
    dailyTurnsCap: 25,
    monthlyTtsCharCap: 200_000,
    monthlyDollarCap: 5,
    alertDailyDollarThreshold: 1,
  },
  standard: {
    dailyTurnsCap: 200,
    monthlyTtsCharCap: 2_000_000,
    monthlyDollarCap: 100,
    alertDailyDollarThreshold: 10,
  },
  pro: {
    dailyTurnsCap: 1000,
    monthlyTtsCharCap: null, // unlimited
    monthlyDollarCap: 500,
    alertDailyDollarThreshold: 50,
  },
  enterprise: {
    dailyTurnsCap: null,
    monthlyTtsCharCap: null,
    monthlyDollarCap: null,
    alertDailyDollarThreshold: 200,
  },
};

const DEFAULT_TIER: Exclude<VoiceQuotaConfig['tier'], 'custom'> = 'standard';

// Resolve the effective quota for an org. If org.voice_quota is null, fall
// back to the platform default tier. If it's a known tier, fold in any
// stored overrides on top of the tier's defaults. 'custom' uses whatever
// caps are stored verbatim.
export function resolveQuota(stored: VoiceQuotaConfig | null | undefined): VoiceQuotaConfig {
  if (!stored) {
    return { tier: DEFAULT_TIER, ...TIER_DEFAULTS[DEFAULT_TIER] };
  }
  if (stored.tier === 'custom') return stored;
  // After the 'custom' early-return, stored.tier is narrowed to a known
  // tier key — but we read the tier-default through a typed lookup so a
  // bad value persisted in the DB falls back gracefully rather than
  // letting `undefined` leak into the cap arithmetic.
  const tierKey: Exclude<VoiceQuotaConfig['tier'], 'custom'> = (
    ['free', 'standard', 'pro', 'enterprise'] as const
  ).includes(stored.tier as 'free' | 'standard' | 'pro' | 'enterprise')
    ? (stored.tier as Exclude<VoiceQuotaConfig['tier'], 'custom'>)
    : DEFAULT_TIER;
  const base = TIER_DEFAULTS[tierKey];
  return {
    tier: stored.tier,
    dailyTurnsCap: stored.dailyTurnsCap ?? base.dailyTurnsCap,
    monthlyTtsCharCap: stored.monthlyTtsCharCap ?? base.monthlyTtsCharCap,
    monthlyDollarCap: stored.monthlyDollarCap ?? base.monthlyDollarCap,
    alertDailyDollarThreshold:
      stored.alertDailyDollarThreshold ?? base.alertDailyDollarThreshold,
  };
}

// =============================================================================
// Quota enforcement
// =============================================================================

export type VoiceQuotaKind = 'stt' | 'tts' | 'verify';

export interface QuotaUsageSnapshot {
  /** STT calls in the current UTC day. Used as the "turns" counter. */
  dailyTurns: number;
  /** TTS chars synthesized in the current UTC month. */
  monthlyTtsChars: number;
  /** Total cost in cents in the current UTC month (across all kinds). */
  monthlyCostCents: number;
  /** Total cost in cents in the current UTC day (drives the Slack alarm). */
  dailyCostCents: number;
}

/**
 * Pull the org's current usage snapshot. Two small aggregate queries run
 * in parallel; on the (org_id, created_at) index they're index-only.
 *
 * Implemented via db.execute() rather than the query builder because this
 * monorepo has two coexisting drizzle-orm versions hoisted from different
 * dependents — the type-level SQL<unknown> values from each don't unify,
 * so the .select() builder rejects sql`...` aggregates. Raw SQL avoids it.
 */
export async function getUsageSnapshot(
  db: Database,
  organizationId: string,
): Promise<QuotaUsageSnapshot> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [dailyRows, monthlyRows] = await Promise.all([
    db.execute<{ turns: number; cost_cents: string }>(
      sql`SELECT
            COUNT(*) FILTER (WHERE kind = 'stt')::int AS turns,
            COALESCE(SUM(cost_cents), 0) AS cost_cents
          FROM voice_usage
          WHERE organization_id = ${organizationId}
            AND created_at >= ${dayStart.toISOString()}`,
    ),
    db.execute<{ tts_chars: number; cost_cents: string }>(
      sql`SELECT
            COALESCE(SUM(units) FILTER (WHERE kind = 'tts'), 0)::int AS tts_chars,
            COALESCE(SUM(cost_cents), 0) AS cost_cents
          FROM voice_usage
          WHERE organization_id = ${organizationId}
            AND created_at >= ${monthStart.toISOString()}`,
    ),
  ]);

  // postgres-js returns numeric columns as strings (lossless); cast at the
  // boundary. Counts come through as ints already after our ::int casts.
  const daily = (dailyRows as unknown as Array<{ turns: number; cost_cents: string }>)[0];
  const monthly = (monthlyRows as unknown as Array<{ tts_chars: number; cost_cents: string }>)[0];
  return {
    dailyTurns: Number(daily?.turns ?? 0),
    dailyCostCents: Number(daily?.cost_cents ?? 0),
    monthlyTtsChars: Number(monthly?.tts_chars ?? 0),
    monthlyCostCents: Number(monthly?.cost_cents ?? 0),
  };
}

export class QuotaExceededError extends Error {
  statusCode = 429;
  constructor(
    public readonly reason:
      | 'daily-turns'
      | 'monthly-tts-chars'
      | 'monthly-dollar-cap',
    public readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
  }
}

// Seconds until the next UTC day boundary — the natural retry-after for
// daily caps. Monthly caps return ~end-of-month.
function secondsUntilTomorrowUtc(now = new Date()): number {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
}
function secondsUntilNextMonthUtc(now = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.max(3600, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/**
 * Check whether one more call of `kind` would breach any cap. Throws
 * QuotaExceededError if so. Cheap to call before each request — the
 * snapshot is one DB hit (two parallel queries) and the threshold checks
 * are pure math. `additionalUnits` lets the caller declare "I'm about to
 * write N TTS chars" so we reject before the vendor call rather than
 * after — useful because TTS is the priciest leg.
 */
export async function enforceVoiceQuota(
  db: Database,
  organizationId: string,
  storedQuota: VoiceQuotaConfig | null,
  kind: VoiceQuotaKind,
  additionalUnits = 0,
): Promise<{ snapshot: QuotaUsageSnapshot; quota: VoiceQuotaConfig }> {
  const quota = resolveQuota(storedQuota);
  const snapshot = await getUsageSnapshot(db, organizationId);

  // Daily turns — counted as STT calls. (Preflight greetings are TTS-only
  // and intentionally don't count against the turn cap; they're a freebie
  // that improves perceived quality.)
  if (
    kind === 'stt' &&
    quota.dailyTurnsCap !== null &&
    snapshot.dailyTurns >= quota.dailyTurnsCap
  ) {
    throw new QuotaExceededError(
      'daily-turns',
      secondsUntilTomorrowUtc(),
      `Daily voice turn cap (${quota.dailyTurnsCap}) reached. Resets at 00:00 UTC.`,
    );
  }

  // Monthly TTS chars — only enforced on TTS calls.
  if (
    kind === 'tts' &&
    quota.monthlyTtsCharCap !== null &&
    snapshot.monthlyTtsChars + additionalUnits > quota.monthlyTtsCharCap
  ) {
    throw new QuotaExceededError(
      'monthly-tts-chars',
      secondsUntilNextMonthUtc(),
      `Monthly text-to-speech cap (${quota.monthlyTtsCharCap.toLocaleString()} chars) reached.`,
    );
  }

  // Monthly dollar cap — applies across all kinds.
  if (
    quota.monthlyDollarCap !== null &&
    snapshot.monthlyCostCents >= quota.monthlyDollarCap * 100
  ) {
    throw new QuotaExceededError(
      'monthly-dollar-cap',
      secondsUntilNextMonthUtc(),
      `Monthly voice budget ($${quota.monthlyDollarCap}) reached.`,
    );
  }

  return { snapshot, quota };
}

// =============================================================================
// Usage recording + alarm
// =============================================================================

// In-memory dedup for the daily Slack alarm — fires at most once per
// (org, UTC day). Process restart re-arms it; tolerable noise.
const alarmsFired = new Set<string>();
function alarmKey(orgId: string, now = new Date()): string {
  const d = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  return `${orgId}:${d}`;
}

export interface RecordVoiceUsageInput {
  organizationId: string;
  userId?: string | null;
  assetInstanceId?: string | null;
  kind: VoiceQuotaKind;
  units: number;
  costCents: number;
}

export async function recordVoiceUsage(
  db: Database,
  input: RecordVoiceUsageInput,
): Promise<void> {
  await db.insert(schema.voiceUsage).values({
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    assetInstanceId: input.assetInstanceId ?? null,
    kind: input.kind,
    units: Math.round(input.units),
    costCents: input.costCents.toFixed(4),
  });
}

/**
 * Check whether the org has crossed its daily $ alert threshold. Fires
 * the Slack webhook (best-effort) if so and remembers it in-memory so we
 * don't ping every subsequent call. Safe to call on a hot path — webhook
 * post is detached.
 */
export function maybeFireSpendAlarm(args: {
  webhookUrl: string | undefined;
  organizationId: string;
  organizationName: string;
  quota: VoiceQuotaConfig;
  snapshot: QuotaUsageSnapshot;
  log: { warn: (...a: unknown[]) => void };
}): void {
  if (!args.webhookUrl) return;
  if (args.quota.alertDailyDollarThreshold === null) return;
  if (args.snapshot.dailyCostCents < args.quota.alertDailyDollarThreshold * 100) return;

  const key = alarmKey(args.organizationId);
  if (alarmsFired.has(key)) return;
  alarmsFired.add(key);

  const dollars = (args.snapshot.dailyCostCents / 100).toFixed(2);
  const text = `:warning: Voice spend alarm — *${args.organizationName}* has used $${dollars} of voice/AI today (threshold: $${args.quota.alertDailyDollarThreshold}). Tier: ${args.quota.tier}.`;

  // Detached fetch — we don't want webhook latency on the request path,
  // and a Slack outage shouldn't fail a paying customer's voice call.
  fetch(args.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch((err) => {
    args.log.warn('voice spend alarm webhook failed', err);
  });
}
