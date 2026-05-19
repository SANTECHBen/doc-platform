'use client';

// Field-tech preventive maintenance view for an asset instance.
//
// Layout follows the rest of the PWA's industrial / SCADA design language:
//   - A grid of category cards at the top (Action / Upcoming /
//     Checklists / Troubleshoot / Procedures / History). Each card
//     carries a small LED indicator + count + subtitle — the LED's
//     colour (red pulse / amber pulse / idle grey) communicates urgency
//     so the red reads as a low-key signal, not an alarm.
//   - Tapping a card selects its slice; the chosen slice renders below.
//   - Slice rows use the shared .surface-etched and .pill tokens so this
//     tab matches Parts / Documents / Training.
//
// All data flows and actions unchanged — same refresh, launch hook,
// service-record posts.

import { useEffect, useMemo, useState } from 'react';
import { Clock, Play } from 'lucide-react';
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

// Maps PmStatus / PmPlanBucket['status'] to the shared .pill tone classes.
const STATUS_PILL: Record<PmStatus, { label: string; className: string }> = {
  overdue: { label: 'Overdue', className: 'pill pill-fault' },
  due: { label: 'Due', className: 'pill pill-warn' },
  soon: { label: 'Soon', className: 'pill pill-info' },
  upcoming: { label: 'Upcoming', className: 'pill' },
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
      <p
        className="rounded-md border p-3 text-sm"
        style={{
          borderColor: 'rgba(var(--signal-fault) / 0.4)',
          background: 'rgba(var(--signal-fault) / 0.1)',
          color: 'rgb(var(--signal-fault))',
        }}
      >
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
  const overdueCount =
    dueNow.filter((s) => s.status === 'overdue').length +
    overdueBuckets.filter((b) => b.bucket.status === 'overdue').length;
  const dueTodayCount =
    dueNow.filter((s) => s.status === 'due').length +
    overdueBuckets.filter((b) => b.bucket.status === 'due').length;
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

  // Next-up preview: pick whichever of (upcoming flat schedule,
  // upcoming plan bucket) is sooner — populates the third metric in
  // the strip when nothing is overdue/due.
  const nextItem = (() => {
    const cands: Array<{ label: string; days: number }> = [];
    if (upcoming[0]) {
      cands.push({
        label: upcoming[0].schedule.name,
        days: upcoming[0].daysUntilDue,
      });
    }
    if (upcomingBuckets[0]) {
      cands.push({
        label: `${upcomingBuckets[0].plan.name} · ${upcomingBuckets[0].bucket.frequencyLabel}`,
        days: upcomingBuckets[0].bucket.daysUntilDue,
      });
    }
    return cands.sort((a, b) => a.days - b.days)[0] ?? null;
  })();

  // One card per category. `tone` drives the LED dot (fault = red pulse,
  // warn = amber pulse, idle = grey static). Subtitle is the secondary
  // information line shown under the count.
  const cards: CategoryCard[] = [
    {
      key: 'action',
      label: 'Action',
      count: actionCount,
      tone: actionCount > 0 ? 'fault' : 'idle',
      subtitle:
        actionCount === 0
          ? 'All caught up'
          : [
              overdueCount > 0
                ? `${overdueCount} overdue`
                : null,
              dueTodayCount > 0 ? `${dueTodayCount} due today` : null,
            ]
              .filter(Boolean)
              .join(' · '),
    },
    {
      key: 'upcoming',
      label: 'Upcoming',
      count: upcoming.length,
      tone: 'idle',
      subtitle: nextItem
        ? `Next ${formatDaysUntil(nextItem.days)}`
        : 'None scheduled',
    },
    {
      key: 'checklists',
      label: 'Checklists',
      count: allBuckets.length,
      tone: overdueBuckets.length > 0 ? 'warn' : 'idle',
      subtitle:
        allBuckets.length === 0
          ? 'No checklists authored'
          : `${overdueBuckets.length} need attention`,
    },
    {
      key: 'troubleshoot',
      label: 'Troubleshoot',
      count: troubleshootingTotal,
      tone: 'idle',
      subtitle:
        troubleshooting.length === 0
          ? 'No guides authored'
          : `${troubleshooting.length} guide${troubleshooting.length === 1 ? '' : 's'}`,
    },
    {
      key: 'library',
      label: 'Procedures',
      count: libraryProcedures.length,
      tone: 'idle',
      subtitle:
        libraryProcedures.length === 0
          ? 'No procedures'
          : 'Tap to run ad-hoc',
    },
    {
      key: 'history',
      label: 'History',
      count: data.history.length,
      tone: 'idle',
      subtitle:
        data.history.length === 0
          ? 'No services logged'
          : `Last ${data.history.length} services`,
    },
  ];

  const slice = (() => {
    switch (active) {
      case 'action': {
        const empty = dueNow.length === 0 && overdueBuckets.length === 0;
        if (empty) {
          return (
            <SliceEmpty
              title="Nothing needs action"
              body={
                nextItem
                  ? `Next: "${nextItem.label}" ${formatDaysUntil(nextItem.days)}.`
                  : 'Check back later or browse the procedure library.'
              }
            />
          );
        }
        return (
          <div className="flex flex-col gap-2">
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
              title="Nothing upcoming"
              body="No scheduled maintenance in the planning window."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2">
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
              title="No checklists"
              body="No OEM-style PM checklists are set up for this model."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2">
            <p className="cap">Grouped by frequency</p>
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
              title="No troubleshooting guides"
              body="No symptom-driven triage tables authored for this model yet."
            />
          );
        }
        return (
          <div className="flex flex-col gap-3">
            <p className="cap">Symptom-driven triage</p>
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
              title="No procedures in library"
              body="Every authored procedure is already scheduled above, or no procedures are attached to this asset model."
            />
          );
        }
        return (
          <ul className="flex flex-col">
            {libraryProcedures.map((p) => (
              <ProcedureRow
                key={p.id}
                doc={p}
                onLaunch={() =>
                  onLaunchProcedure(p.id, '', () => void refresh())
                }
              />
            ))}
          </ul>
        );
      case 'history':
        if (data.history.length === 0) {
          return (
            <SliceEmpty
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
          title="No PM schedules for this model"
          body="An admin can author PM schedules from the asset model detail page. Once added, every instance of this model — including this one — will see what's due here."
        />
      ) : (
        <>
          <CategoryGrid
            cards={cards}
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

// 2-column grid of category cards — replaces the previous tab row.
// Each card carries its own LED indicator + count + subtitle, so the
// dedicated "status strip" is no longer needed. Active card gets a
// brand-tinted border; status urgency is communicated by the LED dot
// (.led-fault pulses red, .led-warn pulses amber, .led-idle is static
// grey) rather than by red text — the red reads as a low-key signal,
// not an alarm.
type CategoryTone = 'fault' | 'warn' | 'idle';

type CategoryCard = {
  key: FilterKey;
  label: string;
  count: number;
  tone: CategoryTone;
  subtitle: string;
};

function CategoryGrid({
  cards,
  active,
  onSelect,
}: {
  cards: CategoryCard[];
  active: FilterKey;
  onSelect: (k: FilterKey) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {cards.map((c) => (
        <CategoryCardButton
          key={c.key}
          card={c}
          active={c.key === active}
          onClick={() => onSelect(c.key)}
        />
      ))}
    </div>
  );
}

function CategoryCardButton({
  card,
  active,
  onClick,
}: {
  card: CategoryCard;
  active: boolean;
  onClick: () => void;
}) {
  const ledClass =
    card.tone === 'fault'
      ? 'led led-fault'
      : card.tone === 'warn'
        ? 'led led-warn'
        : 'led led-idle';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="surface-etched flex flex-col items-start gap-1 p-3 text-left"
      style={
        active
          ? {
              borderColor: 'rgb(var(--brand))',
              boxShadow:
                'inset 0 1px 0 rgb(var(--surface-plate-top)), inset 0 -1px 0 rgba(0,0,0,0.18), 0 0 0 1px rgba(var(--brand) / 0.35)',
            }
          : undefined
      }
    >
      <span className="flex items-center gap-2">
        <span className={ledClass} aria-hidden />
        <span className="cap">{card.label}</span>
      </span>
      <span className="font-mono text-2xl font-medium tabular-nums leading-none text-ink-primary">
        {card.count}
      </span>
      <span className="text-[11px] text-ink-tertiary line-clamp-1">
        {card.subtitle}
      </span>
    </button>
  );
}

// PM schedule row — etched card, status pill via shared .pill tokens,
// primary action via shared .btn classes.
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
  const pill = STATUS_PILL[schedule.status];
  const dueText =
    schedule.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(schedule.daysUntilDue)}`
      : schedule.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(schedule.daysUntilDue)} (${formatNextDue(schedule.nextDueAt)})`;

  return (
    <div className="surface-etched flex flex-col gap-3 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={pill.className}>{pill.label}</span>
            <span className="text-[11px] text-ink-tertiary">{dueText}</span>
          </div>
          <div className="mt-1.5 text-[15px] font-medium text-ink-primary">
            {schedule.schedule.name}
          </div>
          {!compact && schedule.schedule.description && (
            <p className="mt-1 text-xs text-ink-secondary">
              {schedule.schedule.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-tertiary">
            <span className="inline-flex items-center gap-1">
              <Clock size={10} strokeWidth={1.75} />
              every {schedule.schedule.cadenceValue} day
              {schedule.schedule.cadenceValue === 1 ? '' : 's'}
            </span>
            {schedule.lastPerformedAt && (
              <span>Last {formatNextDue(schedule.lastPerformedAt)}</span>
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
              className="btn btn-primary"
              style={{ minHeight: 38, padding: '0 14px', fontSize: 13 }}
            >
              <Play size={13} strokeWidth={2.25} />
              Run procedure
            </button>
            <button
              type="button"
              onClick={onMarkDone}
              className="btn btn-secondary"
              style={{ minHeight: 38, padding: '0 12px', fontSize: 12.5 }}
            >
              Mark done
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onMarkDone}
            className="btn btn-primary"
            style={{ minHeight: 38, padding: '0 14px', fontSize: 13 }}
          >
            Mark performed
          </button>
        )}
      </div>
    </div>
  );
}

// Plan bucket — one row per (plan, frequency). Collapsed by default;
// header tap toggles expanded checklist + "mark all performed".
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
  const pill = STATUS_PILL[bucket.status];
  const dueText =
    bucket.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(bucket.daysUntilDue)}`
      : bucket.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(bucket.daysUntilDue)} (${formatNextDue(bucket.nextDueAt)})`;

  return (
    <div className="surface-etched">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={pill.className}>{pill.label}</span>
            <span className="text-[11px] text-ink-tertiary">{dueText}</span>
          </div>
          <div className="mt-1.5 text-[15px] font-medium text-ink-primary">
            {planName}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-ink-tertiary">
            {bucket.frequencyLabel} · {bucket.itemCount} item
            {bucket.itemCount === 1 ? '' : 's'}
          </div>
        </div>
        <span
          aria-hidden
          className="font-mono text-sm leading-none text-ink-tertiary mt-1"
        >
          {expanded ? '−' : '+'}
        </span>
      </button>

      {expanded && (
        <div
          className="flex flex-col gap-2 px-3 pb-3"
          style={{ borderTop: '1px solid rgb(var(--line-subtle))' }}
        >
          <ul className="flex flex-col divide-y divide-line-subtle">
            {bucket.items.map((it) => (
              <li key={it.id} className="flex items-start gap-3 py-2">
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
                    className="btn btn-secondary"
                    style={{ minHeight: 30, padding: '0 10px', fontSize: 11.5 }}
                  >
                    <Play size={11} strokeWidth={2.25} />
                    Run
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onMarkPerformed}
            className="btn btn-primary self-start"
            style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
          >
            Mark all performed
          </button>
        </div>
      )}
    </div>
  );
}

function TroubleshootingGuideCard({
  guide,
  onRunProcedure,
}: {
  guide: TroubleshootingGuide;
  onRunProcedure: (docId: string) => void;
}) {
  return (
    <div className="surface-etched">
      <header
        className="px-3 py-2.5"
        style={{ borderBottom: '1px solid rgb(var(--line-subtle))' }}
      >
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
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-inset"
        aria-expanded={open}
      >
        <span
          aria-hidden
          className="mt-0.5 shrink-0 font-mono text-sm leading-none text-ink-tertiary"
        >
          {open ? '−' : '+'}
        </span>
        <span className="flex-1 text-sm font-medium text-ink-primary">
          {item.symptom}
        </span>
        {item.document && <span className="cap text-brand">RUN</span>}
      </button>
      {open && (
        <div
          className="flex flex-col gap-3 px-3 py-2.5 pl-8 text-xs"
          style={{ background: 'rgb(var(--surface-inset))' }}
        >
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
                    <div className="cap">
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
                    <div className="cap">
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
                className="btn btn-primary self-start"
                style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
              >
                <Play size={12} strokeWidth={2.25} />
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
          className="btn btn-secondary"
          style={{ minHeight: 28, padding: '0 8px', fontSize: 11 }}
          title={`Run ${item.document.title}`}
        >
          <Play size={10} strokeWidth={2.25} />
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
    <li
      className="px-2.5 py-2"
      style={{
        border: '1px solid rgb(var(--line-subtle))',
        background: 'rgb(var(--surface-raised))',
        borderRadius: 4,
      }}
    >
      {cause && (
        <div>
          <div className="cap">Cause</div>
          <div className="mt-0.5 whitespace-pre-line text-ink-secondary">
            {cause}
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <div className={cause ? 'mt-1.5' : ''}>
          <div className="cap">
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
                      className="btn btn-secondary"
                      style={{ minHeight: 28, padding: '0 8px', fontSize: 11 }}
                      title={`Run ${s.document.title}`}
                    >
                      <Play size={10} strokeWidth={2.25} />
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

// Procedure library row — uses the shared list-row chrome so this slice
// looks identical to the parts list / document list.
function ProcedureRow({
  doc,
  onLaunch,
}: {
  doc: DocumentListItem;
  onLaunch: () => void;
}) {
  const isField = doc.source === 'field';
  const isUnverified = isField && doc.verified === false;
  return (
    <li>
      <button
        type="button"
        onClick={onLaunch}
        className="list-row w-full text-left"
      >
        <div className="list-row-body">
          <span className="list-row-title">{doc.title}</span>
          {isField && (
            <span className="mt-1">
              <span
                className={`pill ${isUnverified ? 'pill-warn' : 'pill-ok'}`}
                title={
                  isUnverified
                    ? 'Field-captured procedure — pending admin review'
                    : 'Field-captured procedure — verified by admin'
                }
              >
                {isUnverified ? 'UNVERIFIED' : 'VERIFIED'} · FIELD
              </span>
            </span>
          )}
        </div>
        <div className="list-row-aside">
          <Play size={14} strokeWidth={2} className="text-ink-tertiary" />
        </div>
      </button>
    </li>
  );
}

function HistoryRow({ record }: { record: PmServiceRecordItem }) {
  return (
    <div className="surface-etched p-3 text-sm">
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
        <div className="text-right font-mono text-[11px] text-ink-tertiary">
          <div>{formatNextDue(record.performedAt)}</div>
          <div>{record.performedBy.displayName}</div>
        </div>
      </div>
    </div>
  );
}

function SliceEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="flex flex-col items-center gap-1.5 p-6 text-center"
      style={{
        border: '1px dashed rgb(var(--line))',
        borderRadius: 4,
        background: 'rgb(var(--surface-inset))',
      }}
    >
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-xs text-ink-secondary">{body}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2 p-6 text-center"
      style={{
        border: '1px dashed rgb(var(--line))',
        borderRadius: 4,
        background: 'rgb(var(--surface-inset))',
      }}
    >
      <p className="text-base font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-sm text-ink-secondary">{body}</p>
    </div>
  );
}
