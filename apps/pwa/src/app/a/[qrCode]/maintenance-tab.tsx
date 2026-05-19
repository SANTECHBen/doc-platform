'use client';

// Field-tech preventive maintenance view for an asset instance.
//
// Redesigned to reduce visual clutter:
//   - Health hero at top: at-a-glance "what's my state" summary.
//   - Segmented filter pills below — only one slice renders at a time
//     (Action needed / Upcoming / Checklists / Troubleshoot / Library /
//     History) instead of stacking every section vertically.
//   - Status-accented cards (colored left bar) read priority at a glance.
//   - Procedure library renders as a tile grid for easier thumb-scanning.
//
// All data flows and actions are unchanged — same refresh, same launch
// hook, same service-record posts.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  History as HistoryIcon,
  ListChecks,
  Play,
  Sparkles,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react';
import {
  fetchPmStatus,
  fetchPmPlanStatus,
  fetchTroubleshooting,
  createPmServiceRecord,
  createPmPlanServiceRecord,
  listDocuments,
  type DocumentListItem,
  type PmPlanBucket,
  type PmPlanStatusPayload,
  type PmScheduleStatusItem,
  type PmServiceRecordItem,
  type PmStatus,
  type PmStatusPayload,
  type TroubleshootingCause,
  type TroubleshootingGuide,
} from '@/lib/api';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

const RELATIVE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function formatNextDue(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : RELATIVE_FMT.format(d);
}

function formatDaysUntil(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

const STATUS_TONE: Record<
  PmStatus,
  { label: string; bg: string; text: string; accent: string }
> = {
  overdue: {
    label: 'Overdue',
    bg: 'rgba(var(--signal-fault) / 0.12)',
    text: 'rgb(var(--signal-fault))',
    accent: 'rgb(var(--signal-fault))',
  },
  due: {
    label: 'Due',
    bg: 'rgba(var(--signal-warn) / 0.12)',
    text: 'rgb(var(--signal-warn))',
    accent: 'rgb(var(--signal-warn))',
  },
  soon: {
    label: 'Soon',
    bg: 'rgba(var(--brand) / 0.12)',
    text: 'rgb(var(--brand))',
    accent: 'rgb(var(--brand))',
  },
  upcoming: {
    label: 'Upcoming',
    bg: 'rgba(var(--ink-tertiary) / 0.12)',
    text: 'rgb(var(--ink-tertiary))',
    accent: 'rgb(var(--ink-tertiary))',
  },
};

type FilterKey =
  | 'action'
  | 'upcoming'
  | 'checklists'
  | 'troubleshoot'
  | 'library'
  | 'history';

export function MaintenanceTab({
  assetInstanceId,
  versionId,
  fieldCapturesVersionId,
  onLaunchProcedure,
  onChange,
}: {
  assetInstanceId: string;
  versionId: string | null;
  fieldCapturesVersionId: string | null;
  onLaunchProcedure: (
    docId: string,
    pmScheduleId: string,
    onCompleted: () => void,
  ) => void;
  onChange?: () => void;
}) {
  const [data, setData] = useState<PmStatusPayload | null>(null);
  const [planData, setPlanData] = useState<PmPlanStatusPayload | null>(null);
  const [troubleshooting, setTroubleshooting] = useState<TroubleshootingGuide[]>([]);
  const [procedures, setProcedures] = useState<DocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<FilterKey>('action');

  async function refresh() {
    try {
      const [flat, plans, ts] = await Promise.all([
        fetchPmStatus(assetInstanceId),
        fetchPmPlanStatus(assetInstanceId),
        fetchTroubleshooting(assetInstanceId).catch(() => ({ guides: [] })),
      ]);
      setData(flat);
      setPlanData(plans);
      setTroubleshooting(ts.guides);
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const allBuckets = useMemo(() => {
    if (!planData) return [];
    return planData.plans.flatMap((p) =>
      p.buckets.map((b) => ({ plan: p.plan, bucket: b })),
    );
  }, [planData]);

  async function logPlanPerformed(
    planId: string,
    frequency: PmPlanBucket['frequency'],
  ) {
    try {
      await createPmPlanServiceRecord({
        assetInstanceId,
        planId,
        frequency,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      await refresh();
    } catch (e) {
      alert(`Failed to log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetInstanceId]);

  useEffect(() => {
    let cancelled = false;
    const oemP = versionId
      ? listDocuments(versionId, 'en', false, assetInstanceId)
      : Promise.resolve([] as DocumentListItem[]);
    const fieldP = fieldCapturesVersionId
      ? listDocuments(fieldCapturesVersionId, 'en', false, assetInstanceId)
      : Promise.resolve([] as DocumentListItem[]);
    Promise.all([oemP, fieldP])
      .then(([oem, field]) => {
        if (cancelled) return;
        setProcedures(
          [...oem, ...field].filter((d) => d.kind === 'structured_procedure'),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [versionId, fieldCapturesVersionId, assetInstanceId]);

  const scheduledDocIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of data?.schedules ?? []) {
      if (s.schedule.document) ids.add(s.schedule.document.id);
    }
    return ids;
  }, [data]);

  const libraryProcedures = useMemo(
    () =>
      procedures
        .filter((p) => !scheduledDocIds.has(p.id))
        .sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
        ),
    [procedures, scheduledDocIds],
  );

  if (error) {
    return (
      <p className="rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
        {error}
      </p>
    );
  }
  if (!data) {
    return <p className="text-center text-sm text-ink-tertiary">Loading…</p>;
  }

  const dueNow = data.schedules.filter((s) => s.needsAction);
  const upcoming = data.schedules
    .filter((s) => !s.needsAction)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  const overdueBuckets = allBuckets.filter(
    (b) => b.bucket.status === 'overdue' || b.bucket.status === 'due',
  );
  const upcomingBuckets = allBuckets.filter(
    (b) => b.bucket.status === 'soon' || b.bucket.status === 'upcoming',
  );
  const troubleshootingTotal = troubleshooting.reduce(
    (n, g) => n + g.items.length,
    0,
  );
  const actionCount = dueNow.length + overdueBuckets.length;
  const anyMaintenance =
    data.schedules.length > 0 ||
    allBuckets.length > 0 ||
    troubleshooting.length > 0;
  const nothingScheduled = !anyMaintenance;

  async function logServicePerformed(s: PmScheduleStatusItem) {
    if (!DEV_USER_ID || !DEV_ORG_ID) {
      alert('Sign in required to log service.');
      return;
    }
    try {
      await createPmServiceRecord({
        assetInstanceId,
        pmScheduleId: s.schedule.id,
        documentId: s.schedule.document?.id ?? null,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      await refresh();
    } catch (e) {
      alert(`Failed to log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Compute the "next thing" preview the hero uses when no action is
  // needed — first looks at upcoming flat schedules, then at upcoming
  // plan buckets, picking whichever is sooner.
  const nextItem = (() => {
    const cands: Array<{ name: string; days: number }> = [];
    if (upcoming[0]) {
      cands.push({
        name: upcoming[0].schedule.name,
        days: upcoming[0].daysUntilDue,
      });
    }
    if (upcomingBuckets[0]) {
      cands.push({
        name: `${upcomingBuckets[0].plan.name} · ${upcomingBuckets[0].bucket.frequencyLabel}`,
        days: upcomingBuckets[0].bucket.daysUntilDue,
      });
    }
    return cands.sort((a, b) => a.days - b.days)[0] ?? null;
  })();

  const filters: Array<{
    key: FilterKey;
    label: string;
    icon: LucideIcon;
    count: number;
    tone?: 'fault' | 'warn' | 'neutral';
  }> = [
    {
      key: 'action',
      label: 'Action',
      icon: AlertCircle,
      count: actionCount,
      tone: actionCount > 0 ? 'fault' : 'neutral',
    },
    {
      key: 'upcoming',
      label: 'Upcoming',
      icon: CalendarDays,
      count: upcoming.length,
    },
    {
      key: 'checklists',
      label: 'Checklists',
      icon: ClipboardList,
      count: allBuckets.length,
    },
    {
      key: 'troubleshoot',
      label: 'Troubleshoot',
      icon: Stethoscope,
      count: troubleshootingTotal,
    },
    {
      key: 'library',
      label: 'Procedures',
      icon: ListChecks,
      count: libraryProcedures.length,
    },
    {
      key: 'history',
      label: 'History',
      icon: HistoryIcon,
      count: data.history.length,
    },
  ];

  // Build the content for the active slice. Each slice is responsible
  // for rendering its own empty state inline, so the hero/filters stay
  // visible even when one filter is empty.
  const slice = (() => {
    switch (active) {
      case 'action': {
        const empty = dueNow.length === 0 && overdueBuckets.length === 0;
        if (empty) {
          return (
            <SliceEmpty
              icon={CheckCircle2}
              title="Nothing needs action"
              body={
                nextItem
                  ? `Next: "${nextItem.name}" ${formatDaysUntil(nextItem.days)}.`
                  : 'Check back later or browse the procedure library.'
              }
              tone="ok"
            />
          );
        }
        return (
          <div className="flex flex-col gap-2.5">
            {dueNow.map((s) => (
              <ScheduleCard
                key={s.schedule.id}
                schedule={s}
                onRunProcedure={() => {
                  if (!s.schedule.document) {
                    alert('No procedure attached to this PM schedule yet.');
                    return;
                  }
                  onLaunchProcedure(
                    s.schedule.document.id,
                    s.schedule.id,
                    () => void refresh(),
                  );
                }}
                onMarkDone={() => void logServicePerformed(s)}
              />
            ))}
            {overdueBuckets
              .slice()
              .sort(
                (a, b) =>
                  statusRank(a.bucket.status) - statusRank(b.bucket.status),
              )
              .map((row) => (
                <PlanBucketCard
                  key={`${row.plan.id}:${row.bucket.frequency}`}
                  planName={row.plan.name}
                  bucket={row.bucket}
                  onRunProcedure={(docId) =>
                    onLaunchProcedure(docId, '', () => void refresh())
                  }
                  onMarkPerformed={() =>
                    void logPlanPerformed(row.plan.id, row.bucket.frequency)
                  }
                />
              ))}
          </div>
        );
      }
      case 'upcoming':
        if (upcoming.length === 0) {
          return (
            <SliceEmpty
              icon={CalendarDays}
              title="Nothing upcoming"
              body="No scheduled maintenance in the planning window."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2.5">
            {upcoming.map((s) => (
              <ScheduleCard
                key={s.schedule.id}
                schedule={s}
                compact
                onRunProcedure={() => {
                  if (!s.schedule.document) {
                    alert('No procedure attached to this PM schedule yet.');
                    return;
                  }
                  onLaunchProcedure(
                    s.schedule.document.id,
                    s.schedule.id,
                    () => void refresh(),
                  );
                }}
                onMarkDone={() => void logServicePerformed(s)}
              />
            ))}
          </div>
        );
      case 'checklists':
        if (allBuckets.length === 0) {
          return (
            <SliceEmpty
              icon={ClipboardList}
              title="No checklists"
              body="No OEM-style PM checklists are set up for this model."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs text-ink-tertiary">
              OEM-style PM checklists grouped by frequency. Tap a card to
              expand the rows, then "Mark all performed" once complete.
            </p>
            {allBuckets
              .slice()
              .sort(
                (a, b) =>
                  statusRank(a.bucket.status) - statusRank(b.bucket.status),
              )
              .map((row) => (
                <PlanBucketCard
                  key={`${row.plan.id}:${row.bucket.frequency}`}
                  planName={row.plan.name}
                  bucket={row.bucket}
                  onRunProcedure={(docId) =>
                    onLaunchProcedure(docId, '', () => void refresh())
                  }
                  onMarkPerformed={() =>
                    void logPlanPerformed(row.plan.id, row.bucket.frequency)
                  }
                />
              ))}
          </div>
        );
      case 'troubleshoot':
        if (troubleshooting.length === 0) {
          return (
            <SliceEmpty
              icon={Stethoscope}
              title="No troubleshooting guides"
              body="No symptom-driven triage tables authored for this model yet."
            />
          );
        }
        return (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-ink-tertiary">
              Symptom-driven triage. Tap a symptom to expand the cause +
              remedy; rows with a linked procedure offer "Run procedure".
            </p>
            {troubleshooting.map((g) => (
              <TroubleshootingGuideCard
                key={g.guide.id}
                guide={g}
                onRunProcedure={(docId) =>
                  onLaunchProcedure(docId, '', () => void refresh())
                }
              />
            ))}
          </div>
        );
      case 'library':
        if (libraryProcedures.length === 0) {
          return (
            <SliceEmpty
              icon={ListChecks}
              title="No procedures in library"
              body="Every authored procedure is already scheduled above, or no procedures are attached to this asset model."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs text-ink-tertiary">
              Tap any procedure to open it as a Job Aid. PM-scheduled
              procedures live in the other tabs.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {libraryProcedures.map((p) => (
                <ProcedureTile
                  key={p.id}
                  doc={p}
                  onLaunch={() =>
                    onLaunchProcedure(p.id, '', () => void refresh())
                  }
                />
              ))}
            </div>
          </div>
        );
      case 'history':
        if (data.history.length === 0) {
          return (
            <SliceEmpty
              icon={HistoryIcon}
              title="No service history yet"
              body="Once maintenance is logged on this asset, you'll see it here."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2">
            {data.history.map((h) => (
              <HistoryRow key={h.id} record={h} />
            ))}
          </div>
        );
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      {nothingScheduled && libraryProcedures.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No PM schedules for this model"
          body="An admin can author PM schedules from the asset model detail page. Once added, every instance of this model — including this one — will see what's due here."
        />
      ) : (
        <>
          <HealthHero
            actionCount={actionCount}
            overdueCount={dueNow.filter((s) => s.status === 'overdue').length +
              overdueBuckets.filter((b) => b.bucket.status === 'overdue').length}
            dueTodayCount={dueNow.filter((s) => s.status === 'due').length +
              overdueBuckets.filter((b) => b.bucket.status === 'due').length}
            nextItem={nextItem}
            anyMaintenance={anyMaintenance}
            onActOnIssues={() => setActive('action')}
          />

          <FilterBar
            filters={filters}
            active={active}
            onSelect={setActive}
          />

          {slice}
        </>
      )}
    </div>
  );
}

function statusRank(s: PmPlanBucket['status']): number {
  switch (s) {
    case 'overdue':
      return 0;
    case 'due':
      return 1;
    case 'soon':
      return 2;
    case 'upcoming':
      return 3;
  }
}

// Health hero — the visual anchor of the tab. Three states:
//   - action needed: red gradient, action count + breakdown
//   - all caught up: green check, next-up preview
//   - nothing scheduled yet: neutral, encouraging copy
function HealthHero({
  actionCount,
  overdueCount,
  dueTodayCount,
  nextItem,
  anyMaintenance,
  onActOnIssues,
}: {
  actionCount: number;
  overdueCount: number;
  dueTodayCount: number;
  nextItem: { name: string; days: number } | null;
  anyMaintenance: boolean;
  onActOnIssues: () => void;
}) {
  const needsAction = actionCount > 0;
  const tone = needsAction
    ? {
        accent: 'rgb(var(--signal-fault))',
        bg: 'rgba(var(--signal-fault) / 0.08)',
        icon: AlertTriangle,
        label: 'Action needed',
      }
    : anyMaintenance
      ? {
          accent: 'rgb(var(--signal-ok))',
          bg: 'rgba(var(--signal-ok) / 0.08)',
          icon: CheckCircle2,
          label: 'All caught up',
        }
      : {
          accent: 'rgb(var(--ink-tertiary))',
          bg: 'rgba(var(--ink-tertiary) / 0.06)',
          icon: Sparkles,
          label: 'Ready',
        };
  const Icon = tone.icon;

  return (
    <button
      type="button"
      onClick={needsAction ? onActOnIssues : undefined}
      disabled={!needsAction}
      className="relative flex w-full items-stretch gap-3 overflow-hidden rounded-xl border bg-surface-raised p-4 text-left transition disabled:cursor-default"
      style={{
        borderColor: tone.accent,
        background: `linear-gradient(135deg, ${tone.bg}, transparent 80%)`,
      }}
    >
      <div
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
        style={{ background: `${tone.accent}1a` }}
      >
        <Icon size={26} strokeWidth={2} style={{ color: tone.accent }} />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: tone.accent }}
        >
          {tone.label}
        </div>
        {needsAction ? (
          <>
            <div className="mt-0.5 text-xl font-semibold text-ink-primary">
              {actionCount} item{actionCount === 1 ? '' : 's'} to handle
            </div>
            <div className="mt-0.5 text-xs text-ink-secondary">
              {overdueCount > 0 && (
                <span>
                  <span
                    className="font-semibold"
                    style={{ color: 'rgb(var(--signal-fault))' }}
                  >
                    {overdueCount} overdue
                  </span>
                  {dueTodayCount > 0 ? ' · ' : ''}
                </span>
              )}
              {dueTodayCount > 0 && (
                <span>
                  <span
                    className="font-semibold"
                    style={{ color: 'rgb(var(--signal-warn))' }}
                  >
                    {dueTodayCount} due today
                  </span>
                </span>
              )}
            </div>
          </>
        ) : anyMaintenance ? (
          <>
            <div className="mt-0.5 text-xl font-semibold text-ink-primary">
              No maintenance due
            </div>
            {nextItem && (
              <div className="mt-0.5 truncate text-xs text-ink-secondary">
                Next: <span className="text-ink-primary">{nextItem.name}</span>{' '}
                · {formatDaysUntil(nextItem.days)}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mt-0.5 text-xl font-semibold text-ink-primary">
              Procedures only
            </div>
            <div className="mt-0.5 text-xs text-ink-secondary">
              No PM schedules yet — browse the library to run ad-hoc.
            </div>
          </>
        )}
      </div>
      {needsAction && (
        <ChevronRight
          size={20}
          strokeWidth={2}
          className="shrink-0 self-center text-ink-tertiary"
        />
      )}
    </button>
  );
}

// Horizontal scrollable filter bar — pill segmented control. The active
// pill gets the brand fill + raised contrast; inactive pills stay quiet.
// Counts render as a small chip and turn red on the Action pill when
// there's outstanding work.
function FilterBar({
  filters,
  active,
  onSelect,
}: {
  filters: Array<{
    key: FilterKey;
    label: string;
    icon: LucideIcon;
    count: number;
    tone?: 'fault' | 'warn' | 'neutral';
  }>;
  active: FilterKey;
  onSelect: (k: FilterKey) => void;
}) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {filters.map((f) => {
        const isActive = f.key === active;
        const isFault = f.tone === 'fault' && f.count > 0;
        const Icon = f.icon;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onSelect(f.key)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition"
            style={
              isActive
                ? {
                    background: 'rgb(var(--brand))',
                    color: 'rgb(var(--ink-on-brand, 255 255 255))',
                    borderColor: 'rgb(var(--brand))',
                  }
                : {
                    background: 'rgb(var(--surface-raised))',
                    color: 'rgb(var(--ink-secondary))',
                    borderColor: 'rgb(var(--line))',
                  }
            }
          >
            <Icon size={13} strokeWidth={2} />
            <span>{f.label}</span>
            {f.count > 0 && (
              <span
                className="ml-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none"
                style={
                  isActive
                    ? {
                        background: 'rgba(255 255 255 / 0.22)',
                        color: 'rgb(var(--ink-on-brand, 255 255 255))',
                        paddingBlock: '3px',
                      }
                    : isFault
                      ? {
                          background: 'rgb(var(--signal-fault))',
                          color: 'rgb(var(--ink-on-brand, 255 255 255))',
                          paddingBlock: '3px',
                        }
                      : {
                          background: 'rgba(var(--ink-tertiary) / 0.15)',
                          color: 'rgb(var(--ink-tertiary))',
                          paddingBlock: '3px',
                        }
                }
              >
                {f.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Status-accented PM schedule card. Colored left bar (red/amber/blue/grey)
// reads priority at a glance; primary action is the dominant brand button.
function ScheduleCard({
  schedule,
  compact,
  onRunProcedure,
  onMarkDone,
}: {
  schedule: PmScheduleStatusItem;
  compact?: boolean;
  onRunProcedure: () => void;
  onMarkDone: () => void;
}) {
  const tone = STATUS_TONE[schedule.status];
  const dueText =
    schedule.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(schedule.daysUntilDue)}`
      : schedule.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(schedule.daysUntilDue)} (${formatNextDue(schedule.nextDueAt)})`;

  return (
    <div
      className="relative flex flex-col gap-3 overflow-hidden rounded-xl border bg-surface-raised p-3.5 pl-4"
      style={{ borderColor: 'rgb(var(--line))' }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: tone.accent }}
      />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ background: tone.bg, color: tone.text }}
            >
              {tone.label}
            </span>
            <span className="text-[11px] text-ink-tertiary">{dueText}</span>
          </div>
          <div className="mt-1 text-base font-semibold text-ink-primary">
            {schedule.schedule.name}
          </div>
          {!compact && schedule.schedule.description && (
            <p className="mt-1 text-xs text-ink-secondary">
              {schedule.schedule.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-ink-tertiary">
            <span className="inline-flex items-center gap-1">
              <Clock size={10} strokeWidth={1.75} />
              every {schedule.schedule.cadenceValue} day
              {schedule.schedule.cadenceValue === 1 ? '' : 's'}
            </span>
            {schedule.lastPerformedAt && (
              <span>Last: {formatNextDue(schedule.lastPerformedAt)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {schedule.schedule.document ? (
          <>
            <button
              type="button"
              onClick={onRunProcedure}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
              style={{
                background: 'rgb(var(--brand))',
                color: 'rgb(var(--ink-on-brand, 255 255 255))',
              }}
            >
              <Play size={12} strokeWidth={2.5} />
              Run procedure
            </button>
            <button
              type="button"
              onClick={onMarkDone}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-secondary hover:bg-surface-inset"
            >
              <CheckCircle2 size={12} strokeWidth={2} />
              Mark done
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onMarkDone}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
            style={{
              background: 'rgb(var(--brand))',
              color: 'rgb(var(--ink-on-brand, 255 255 255))',
            }}
          >
            <CheckCircle2 size={12} strokeWidth={2.5} />
            Mark performed
          </button>
        )}
      </div>
    </div>
  );
}

// One card per (plan, frequency) bucket — same accent-bar treatment as
// the schedule card. Collapsed by default; expand reveals checklist rows.
function PlanBucketCard({
  planName,
  bucket,
  onRunProcedure,
  onMarkPerformed,
}: {
  planName: string;
  bucket: PmPlanBucket;
  onRunProcedure: (docId: string) => void;
  onMarkPerformed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tone = STATUS_TONE[bucket.status];
  const dueText =
    bucket.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(bucket.daysUntilDue)}`
      : bucket.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(bucket.daysUntilDue)} (${formatNextDue(bucket.nextDueAt)})`;

  return (
    <div
      className="relative overflow-hidden rounded-xl border bg-surface-raised"
      style={{ borderColor: 'rgb(var(--line))' }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: tone.accent }}
      />
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-start gap-3 p-3.5 pl-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ background: tone.bg, color: tone.text }}
            >
              {tone.label}
            </span>
            <span className="text-[11px] text-ink-tertiary">{dueText}</span>
          </div>
          <div className="mt-1 text-base font-semibold text-ink-primary">
            {planName}
          </div>
          <div className="mt-0.5 text-xs text-ink-tertiary">
            {bucket.frequencyLabel} checks · {bucket.itemCount} item
            {bucket.itemCount === 1 ? '' : 's'}
          </div>
        </div>
        <ChevronRight
          size={18}
          strokeWidth={2}
          className="shrink-0 self-center text-ink-tertiary transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pl-4">
          <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line-subtle bg-surface">
            {bucket.items.map((it) => (
              <li key={it.id} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-primary">
                    {it.component}
                    <span className="text-ink-tertiary"> · </span>
                    {it.checkText}
                  </div>
                  {it.remarks && (
                    <div className="mt-0.5 text-xs text-ink-secondary">
                      {it.remarks}
                    </div>
                  )}
                </div>
                {it.document && (
                  <button
                    type="button"
                    onClick={() => onRunProcedure(it.document!.id)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/40 bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10"
                  >
                    <Play size={11} strokeWidth={2.5} />
                    Run
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onMarkPerformed}
            className="self-start inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
            style={{
              background: 'rgb(var(--brand))',
              color: 'rgb(var(--ink-on-brand, 255 255 255))',
            }}
          >
            <CheckCircle2 size={12} strokeWidth={2.5} />
            Mark all performed
          </button>
        </div>
      )}
    </div>
  );
}

// Troubleshooting guide card — rounded surface, guide name as a clear
// header, rows divided by hairlines.
function TroubleshootingGuideCard({
  guide,
  onRunProcedure,
}: {
  guide: TroubleshootingGuide;
  onRunProcedure: (docId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
      <header className="border-b border-line-subtle bg-surface-inset/40 px-3.5 py-2.5">
        <h4 className="text-sm font-semibold text-ink-primary">
          {guide.guide.name}
        </h4>
        {guide.guide.description && (
          <p className="mt-0.5 text-xs text-ink-secondary">
            {guide.guide.description}
          </p>
        )}
      </header>
      <ul className="divide-y divide-line-subtle">
        {guide.items.map((it) => (
          <TroubleshootingRow
            key={it.id}
            item={it}
            onRunProcedure={onRunProcedure}
          />
        ))}
      </ul>
    </div>
  );
}

function TroubleshootingRow({
  item,
  onRunProcedure,
}: {
  item: TroubleshootingGuide['items'][number];
  onRunProcedure: (docId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2 px-3.5 py-2.5 text-left hover:bg-surface-inset"
      >
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-ink-tertiary transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="flex-1 text-sm font-medium text-ink-primary">
          {item.symptom}
        </span>
        {item.document && (
          <span
            className="shrink-0 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand"
            title="Has linked procedure"
          >
            Run
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-3 bg-surface-inset/40 px-3.5 py-2.5 pl-9 text-xs">
          {(() => {
            const paired = (item.causes ?? []).filter(
              (c) =>
                c.cause.trim().length > 0 ||
                (c.remedySteps ?? []).some((s) => s.text.trim().length > 0),
            );
            if (paired.length > 0) {
              return (
                <ul className="flex flex-col gap-2">
                  {paired.map((c, i) => (
                    <PairedCauseBlock
                      key={i}
                      entry={c}
                      onRunProcedure={onRunProcedure}
                    />
                  ))}
                </ul>
              );
            }
            const hasLegacyStruct =
              item.causeItems.length > 0 || item.remedyItems.length > 0;
            const hasLegacyText = item.cause || item.remedy;
            if (!hasLegacyStruct && !hasLegacyText) return null;
            return (
              <>
                {(item.causeItems.length > 0 || item.cause) && (
                  <div>
                    <div className="font-semibold uppercase text-ink-tertiary text-[10px] tracking-wider">
                      {item.causeItems.length > 1 ? 'Causes' : 'Cause'}
                    </div>
                    {item.causeItems.length > 0 ? (
                      <ul className="mt-1 flex flex-col gap-1.5">
                        {item.causeItems.map((c, i) => (
                          <StructItemRow
                            key={i}
                            item={c}
                            onRunProcedure={onRunProcedure}
                          />
                        ))}
                      </ul>
                    ) : (
                      <div className="mt-0.5 text-ink-secondary whitespace-pre-line">
                        {item.cause}
                      </div>
                    )}
                  </div>
                )}
                {(item.remedyItems.length > 0 || item.remedy) && (
                  <div>
                    <div className="font-semibold uppercase text-ink-tertiary text-[10px] tracking-wider">
                      {item.remedyItems.length > 1 ? 'Remedy steps' : 'Remedy'}
                    </div>
                    {item.remedyItems.length > 0 ? (
                      <ul className="mt-1 flex flex-col gap-1.5">
                        {item.remedyItems.map((r, i) => (
                          <StructItemRow
                            key={i}
                            item={r}
                            onRunProcedure={onRunProcedure}
                          />
                        ))}
                      </ul>
                    ) : (
                      <div className="mt-0.5 text-ink-secondary whitespace-pre-line">
                        {item.remedy}
                      </div>
                    )}
                  </div>
                )}
              </>
            );
          })()}
          {item.document &&
            (item.causes ?? []).length === 0 &&
            item.remedyItems.length === 0 && (
              <button
                type="button"
                onClick={() => onRunProcedure(item.document!.id)}
                className="self-start inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold"
                style={{
                  background: 'rgb(var(--brand))',
                  color: 'rgb(var(--ink-on-brand, 255 255 255))',
                }}
              >
                <Play size={12} strokeWidth={2.5} />
                Run procedure: {item.document.title}
              </button>
            )}
        </div>
      )}
    </li>
  );
}

function StructItemRow({
  item,
  onRunProcedure,
}: {
  item: { text: string; document: { id: string; title: string } | null };
  onRunProcedure: (docId: string) => void;
}) {
  if (!item.text.trim()) return null;
  return (
    <li className="flex items-start gap-2">
      <span
        className="mt-0.5 shrink-0 select-none text-ink-tertiary"
        aria-hidden
      >
        •
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-line text-ink-secondary">
        {item.text}
      </span>
      {item.document && (
        <button
          type="button"
          onClick={() => onRunProcedure(item.document!.id)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/40 bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10"
          title={`Run ${item.document.title}`}
        >
          <Play size={11} strokeWidth={2.5} />
          Run
        </button>
      )}
    </li>
  );
}

function PairedCauseBlock({
  entry,
  onRunProcedure,
}: {
  entry: TroubleshootingCause;
  onRunProcedure: (docId: string) => void;
}) {
  const cause = entry.cause.trim();
  const steps = (entry.remedySteps ?? []).filter(
    (s) => s.text.trim().length > 0,
  );
  if (!cause && steps.length === 0) return null;
  const ListTag = entry.remedyStyle === 'numbered' ? 'ol' : 'ul';
  const listClass =
    entry.remedyStyle === 'numbered' ? 'list-decimal' : 'list-disc';
  return (
    <li className="rounded-md border border-line-subtle bg-surface px-2.5 py-2">
      {cause && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
            Cause
          </div>
          <div className="mt-0.5 whitespace-pre-line text-ink-secondary">
            {cause}
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <div className={cause ? 'mt-1.5' : ''}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
            {steps.length > 1 ? 'Remedy steps' : 'Remedy'}
          </div>
          <ListTag className={`${listClass} mt-1 ml-5 flex flex-col gap-1`}>
            {steps.map((s, i) => (
              <li
                key={i}
                className="text-ink-secondary marker:text-ink-tertiary"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <span className="min-w-0 flex-1 whitespace-pre-line">
                    {s.text}
                  </span>
                  {s.document && (
                    <button
                      type="button"
                      onClick={() => onRunProcedure(s.document!.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/40 bg-brand/5 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/10"
                      title={`Run ${s.document.title}`}
                    >
                      <Play size={11} strokeWidth={2.5} />
                      Run
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ListTag>
        </div>
      )}
    </li>
  );
}

// Procedure library tile — two per row, easy thumb-tap target. Icon
// header, title body, verified chip footer when relevant.
function ProcedureTile({
  doc,
  onLaunch,
}: {
  doc: DocumentListItem;
  onLaunch: () => void;
}) {
  const isField = doc.source === 'field';
  const isUnverified = isField && doc.verified === false;
  return (
    <button
      type="button"
      onClick={onLaunch}
      className="group flex h-full flex-col gap-2 rounded-xl border border-line bg-surface-raised p-3 text-left transition hover:border-brand/40 hover:bg-brand/5"
    >
      <div className="flex items-center justify-between">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{
            background: 'rgba(var(--brand) / 0.1)',
            color: 'rgb(var(--brand))',
          }}
        >
          <ListChecks size={16} strokeWidth={2} />
        </span>
        <Play
          size={14}
          strokeWidth={2.5}
          className="text-ink-tertiary transition group-hover:text-brand"
        />
      </div>
      <span className="line-clamp-3 text-sm font-medium text-ink-primary">
        {doc.title}
      </span>
      {isField && (
        <span
          className={`mt-auto inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase ${
            isUnverified
              ? 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
              : 'border-signal-ok/40 bg-signal-ok/10 text-signal-ok'
          }`}
          title={
            isUnverified
              ? 'Field-captured procedure — pending admin review'
              : 'Field-captured procedure — verified by admin'
          }
        >
          {isUnverified ? 'unverified' : 'verified'} · field
        </span>
      )}
    </button>
  );
}

function HistoryRow({ record }: { record: PmServiceRecordItem }) {
  return (
    <div className="rounded-xl border border-line-subtle bg-surface-raised p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink-primary">
            {record.pmSchedule?.name ?? (
              <span className="italic text-ink-tertiary">Ad-hoc service</span>
            )}
          </div>
          {record.document && (
            <div className="text-xs text-ink-tertiary">
              {record.document.title}
            </div>
          )}
          {record.notes && (
            <p className="mt-1 text-xs text-ink-secondary">{record.notes}</p>
          )}
        </div>
        <div className="text-right text-xs text-ink-tertiary">
          <div>{formatNextDue(record.performedAt)}</div>
          <div>{record.performedBy.displayName}</div>
        </div>
      </div>
    </div>
  );
}

// Per-slice empty state — smaller and less heavy than the page-level
// EmptyState since the hero already framed the situation.
function SliceEmpty({
  icon: Icon,
  title,
  body,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  tone?: 'ok';
}) {
  const color =
    tone === 'ok' ? 'rgb(var(--signal-ok))' : 'rgb(var(--ink-tertiary))';
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line bg-surface-raised p-6 text-center">
      <Icon size={24} strokeWidth={1.5} style={{ color }} />
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-xs text-ink-secondary">{body}</p>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  tone?: 'ok';
}) {
  const color =
    tone === 'ok' ? 'rgb(var(--signal-ok))' : 'rgb(var(--ink-tertiary))';
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-surface-raised p-6 text-center">
      <Icon size={28} strokeWidth={1.5} style={{ color }} />
      <p className="text-base font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-sm text-ink-secondary">{body}</p>
    </div>
  );
}
