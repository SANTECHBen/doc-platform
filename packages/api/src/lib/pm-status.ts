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
      nextDueAt = new Date(anchor.getTime() + input.cadenceValue * MS_PER_DAY);
      break;
  }

  const diffMs = nextDueAt.getTime() - input.now.getTime();
  // truncate toward zero so a partially-elapsed day reads as "due today"
  // rather than already 1 day late or 1 day early.
  const daysUntilDue = Math.trunc(diffMs / MS_PER_DAY);

  let status: PmStatus;
  if (diffMs < -input.graceDays * MS_PER_DAY) {
    status = 'overdue';
  } else if (diffMs <= 0) {
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
