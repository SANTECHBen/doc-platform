// Pure functions for computing the due / overdue / soon / upcoming
// status of preventive maintenance schedules against an asset instance.
//
// Decoupled from Drizzle / Fastify so it's trivially unit-testable. The
// API routes do the SQL fetch (latest service record per schedule),
// then call computeScheduleStatus() per schedule and aggregate.
//
// Anchor selection: when a schedule has never been performed against
// the instance, the anchor falls back to instance.installed_at. If the
// instance hasn't been marked installed either, the schedule's own
// created_at is used so brand-new equipment doesn't immediately show
// as "overdue" for every schedule the moment it's deployed.

export type PmStatus = 'overdue' | 'due' | 'soon' | 'upcoming';

export interface ScheduleStatusInput {
  cadenceKind: 'days';
  cadenceValue: number;
  graceDays: number;
  /** When the schedule was created — fallback anchor for instances that
   *  have neither a service record nor an installed_at date. */
  scheduleCreatedAt: Date;
  /** When the asset instance was marked installed at the customer site.
   *  Second-priority anchor. */
  instanceInstalledAt: Date | null;
  /** When this schedule was last performed against this specific
   *  instance. Highest-priority anchor. */
  lastPerformedAt: Date | null;
  /** Reference "now" — accepted as a parameter so tests can inject
   *  deterministic timestamps. */
  now: Date;
  /** IANA timezone the day boundaries are computed in — typically the
   *  asset's site timezone. Daily / weekly / etc. roll over at the
   *  site's local midnight, not UTC's, so a 6pm-Chicago "daily check"
   *  is correctly Due the next Chicago morning instead of waiting a
   *  full 24 elapsed hours. */
  timezone: string;
  /** How many days ahead of next-due to flip status from 'upcoming' to
   *  'soon'. Default = 7. */
  soonWindowDays?: number;
}

export interface ScheduleStatusOutput {
  /** ISO timestamp of the next time this schedule is due to be
   *  performed. Always present — for schedules never performed it's
   *  computed from the instance install / schedule creation anchor. */
  nextDueAt: Date;
  /** Day count: positive = days until due, negative = days overdue.
   *  Rounded toward zero so "due today" reads as 0. */
  daysUntilDue: number;
  status: PmStatus;
  /** True when status is 'overdue' or 'due' — convenience for sorting
   *  and "needs attention now" badges in the PWA. */
  needsAction: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Returns the calendar date in `tz` for `d` as a (y, m, d) triplet. */
function calendarParts(
  d: Date,
  tz: string,
): { year: number; month: number; day: number } {
  // `en-CA` gives ISO-ish YYYY-MM-DD parts which we extract from
  // formatToParts. Falls back to UTC if the tz is invalid.
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = fmt.formatToParts(d);
  return {
    year: Number(parts.find((p) => p.type === 'year')!.value),
    month: Number(parts.find((p) => p.type === 'month')!.value),
    day: Number(parts.find((p) => p.type === 'day')!.value),
  };
}

/** Whole-day difference between two timestamps' calendar days in `tz`.
 *  Positive when `to` is after `from`. Used so a "daily" PM rolls over
 *  at site-local midnight regardless of the time-of-day the check was
 *  last performed. Exported for the per-bucket plan-status route, which
 *  computes its own anchor / cadence outside of this module. */
export function calendarDayDiff(from: Date, to: Date, tz: string): number {
  const a = calendarParts(from, tz);
  const b = calendarParts(to, tz);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) -
      Date.UTC(a.year, a.month - 1, a.day)) /
      MS_PER_DAY,
  );
}

/** UTC Date corresponding to the calendar day `daysOffset` after
 *  `from`'s calendar day in `tz`. Returned as UTC-midnight so the
 *  PWA's UTC date-formatter renders the correct local calendar day. */
function calendarDayAfter(from: Date, daysOffset: number, tz: string): Date {
  const { year, month, day } = calendarParts(from, tz);
  return new Date(Date.UTC(year, month - 1, day + daysOffset));
}

export function computeScheduleStatus(
  input: ScheduleStatusInput,
): ScheduleStatusOutput {
  const soonDays = input.soonWindowDays ?? 7;
  const anchor =
    input.lastPerformedAt ?? input.instanceInstalledAt ?? input.scheduleCreatedAt;

  // v1: only 'days' cadence. The switch is here so future cadence
  // kinds slot in without callers re-thinking the contract.
  let nextDueAt: Date;
  switch (input.cadenceKind) {
    case 'days':
      nextDueAt = calendarDayAfter(anchor, input.cadenceValue, input.timezone);
      break;
  }

  // Calendar-day diff in the site timezone. A daily check performed at
  // 6pm rolls over at the site's next midnight, not after a literal 24
  // elapsed hours — that's what techs expect when they look at a "daily
  // inspection" the next morning.
  const daysSinceAnchor = calendarDayDiff(anchor, input.now, input.timezone);
  const daysUntilDue = input.cadenceValue - daysSinceAnchor;

  let status: PmStatus;
  if (daysUntilDue < -input.graceDays) {
    status = 'overdue';
  } else if (daysUntilDue <= 0) {
    status = 'due';
  } else if (daysUntilDue <= soonDays) {
    status = 'soon';
  } else {
    status = 'upcoming';
  }

  return {
    nextDueAt,
    daysUntilDue,
    status,
    needsAction: status === 'overdue' || status === 'due',
  };
}

export interface AggregateInput {
  schedules: ScheduleStatusInput[];
  now: Date;
}

export interface AggregateOutput {
  overdue: number;
  due: number;
  soon: number;
  upcoming: number;
  /** Convenience for the nameplate badge — "needs attention" count. */
  needsActionCount: number;
}

/** Counts schedules by status. Used by the PWA hub-resolve summary so
 *  the asset hub can render an "Overdue PM" chip without listing every
 *  schedule individually. */
export function aggregateScheduleStatuses(
  input: AggregateInput,
): AggregateOutput {
  const out: AggregateOutput = {
    overdue: 0,
    due: 0,
    soon: 0,
    upcoming: 0,
    needsActionCount: 0,
  };
  for (const s of input.schedules) {
    const r = computeScheduleStatus({ ...s, now: input.now });
    out[r.status] += 1;
    if (r.needsAction) out.needsActionCount += 1;
  }
  return out;
}
