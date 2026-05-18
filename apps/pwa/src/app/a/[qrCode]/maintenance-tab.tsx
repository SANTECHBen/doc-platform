'use client';

// Field-tech preventive maintenance view for an asset instance.
//
// Three sections, in importance order:
//   - Due now: schedules that are overdue or due today. One-tap "Run
//     procedure" launches the same VirtualJobAid the Overview quick
//     actions card uses; on completion we POST a pm_service_record so
//     status flips back to 'upcoming' immediately.
//   - Coming up: schedules due within ~7 days, plus future ones for
//     planning. Shows next due date.
//   - History: last 20 service records on this instance, scheduled or
//     ad-hoc. Lets the tech confirm "I already did this last week" if
//     the system disagrees.
//
// Reuses VirtualJobAid for the actual procedure run; PM specifics are
// confined to fetching status, sorting, and posting service records.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock,
  ListChecks,
  Play,
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
  { label: string; bg: string; text: string }
> = {
  overdue: {
    label: 'Overdue',
    bg: 'rgba(var(--signal-fault) / 0.12)',
    text: 'rgb(var(--signal-fault))',
  },
  due: {
    label: 'Due',
    bg: 'rgba(var(--signal-warn) / 0.12)',
    text: 'rgb(var(--signal-warn))',
  },
  soon: {
    label: 'Soon',
    bg: 'rgba(var(--brand) / 0.12)',
    text: 'rgb(var(--brand))',
  },
  upcoming: {
    label: 'Upcoming',
    bg: 'rgba(var(--ink-tertiary) / 0.12)',
    text: 'rgb(var(--ink-tertiary))',
  },
};

export function MaintenanceTab({
  assetInstanceId,
  versionId,
  fieldCapturesVersionId,
  onLaunchProcedure,
  onChange,
}: {
  assetInstanceId: string;
  /** OEM-pinned content pack version for this asset instance. Used to
   *  fetch the procedure library shown alongside PMs. Nullable for
   *  instances that aren't pinned to any version (rare). */
  versionId: string | null;
  /** Optional field-captures version. Author-on-PWA procedures live here
   *  and should appear in the library next to OEM-authored procedures. */
  fieldCapturesVersionId: string | null;
  /** Mounts a VirtualJobAid for the picked procedure doc — same hook
   *  the Overview quick-actions uses, so the run UX is identical. */
  onLaunchProcedure: (
    docId: string,
    pmScheduleId: string,
    onCompleted: () => void,
  ) => void;
  /** Called when the maintenance state changes (e.g. after a service
   *  record is posted) so the parent can refresh the hub badge. */
  onChange?: () => void;
}) {
  const [data, setData] = useState<PmStatusPayload | null>(null);
  // PM Plans — checklist-style PMs with per-row frequency. Rendered as
  // a dedicated section between the flat schedule sections and the
  // procedure library so the tech sees plans grouped by (plan, frequency)
  // instead of one row per check.
  const [planData, setPlanData] = useState<PmPlanStatusPayload | null>(null);
  // OEM-style triage tables — reactive (tech has a symptom, looks it up)
  // rather than scheduled. Rendered as a dedicated section below
  // Checklists so the tech sees scheduled-work first, then symptom-driven.
  const [troubleshooting, setTroubleshooting] = useState<TroubleshootingGuide[]>([]);
  // Procedure library — every structured_procedure attached to this
  // asset model (OEM pack + field captures). Rendered as the "Procedures"
  // section below the PM cards. Fetched once on mount + when version IDs
  // change.
  const [procedures, setProcedures] = useState<DocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  // Flatten plan buckets across plans for status-bucket sorting in the
  // Checklists section. Each entry carries its parent plan so the card
  // can render "Plan name — Daily checks".
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

  // Procedure library fetch. Parallel calls to OEM + field-captures
  // versions, filter to kind === 'structured_procedure', concat. Errors
  // here don't block the rest of the tab — we just render an empty
  // library section.
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
          [...oem, ...field].filter(
            (d) => d.kind === 'structured_procedure',
          ),
        );
      })
      .catch(() => {
        // Non-fatal: PM cards above still render. Empty library is fine.
      });
    return () => {
      cancelled = true;
    };
  }, [versionId, fieldCapturesVersionId, assetInstanceId]);

  // De-dupe procedures already referenced by a PM schedule above —
  // showing the same procedure twice in one screen reads as a bug.
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
        // Alphabetical so the same procedure doesn't bounce around the
        // list between renders. Source order from the API is by ordering
        // hint which the admin tuned for the Documents tab; here a
        // tech-scannable A-Z is clearer.
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
    return (
      <p className="text-center text-sm text-ink-tertiary">Loading…</p>
    );
  }

  const dueNow = data.schedules.filter((s) => s.needsAction);
  const upcoming = data.schedules
    .filter((s) => !s.needsAction)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  // "Anything maintenance-y exists" combines flat schedules + plan buckets
  // + troubleshooting guides — so the empty/all-done states reflect the
  // whole surface, not just the flat-schedule slice.
  const anyMaintenance =
    data.schedules.length > 0 ||
    allBuckets.length > 0 ||
    troubleshooting.length > 0;
  const anyNeedsAction =
    dueNow.length > 0 ||
    allBuckets.some((b) => b.bucket.needsAction);
  const allDone = anyMaintenance && !anyNeedsAction;
  const nothingScheduled = !anyMaintenance;

  async function logServicePerformed(s: PmScheduleStatusItem) {
    if (!DEV_USER_ID || !DEV_ORG_ID) {
      // Without an identified user we can't attribute the record. Skip
      // gracefully — most prod paths will go through Run procedure
      // (which posts the record server-side via the run completion
      // hook in v1.1) or via authenticated sign-in (v2).
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

  return (
    <div className="flex flex-col gap-5">
      {nothingScheduled && libraryProcedures.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No PM schedules for this model"
          body="An admin can author PM schedules from the asset model detail page. Once added, every instance of this model — including this one — will see what's due here."
        />
      ) : nothingScheduled ? (
        <EmptyState
          icon={CalendarClock}
          title="No scheduled maintenance"
          body="No PM schedules are set up for this model yet. The procedures available for this asset are listed below — tap one to run it ad-hoc."
        />
      ) : allDone ? (
        <EmptyState
          icon={CheckCircle2}
          title="All caught up"
          body={`The next maintenance is ${
            upcoming[0]
              ? `"${upcoming[0].schedule.name}" ${formatDaysUntil(upcoming[0].daysUntilDue)}`
              : 'beyond the planning window'
          }.`}
          tone="ok"
        />
      ) : null}

      {dueNow.length > 0 && (
        <Section title="Due now" badgeCount={dueNow.length} icon={AlertCircle}>
          <ol className="flex flex-col gap-2">
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
          </ol>
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section
          title="Coming up"
          badgeCount={upcoming.length}
          icon={CalendarDays}
        >
          <ol className="flex flex-col gap-2">
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
          </ol>
        </Section>
      )}

      {allBuckets.length > 0 && (
        <Section
          title="Checklists"
          badgeCount={allBuckets.length}
          icon={ClipboardList}
        >
          <p className="mb-2 text-xs text-ink-tertiary">
            OEM-style PM checklists grouped by frequency. Tap a card to expand
            the rows, then "Mark all performed" once you've completed them.
          </p>
          <ol className="flex flex-col gap-2">
            {allBuckets
              .slice()
              .sort((a, b) => statusRank(a.bucket.status) - statusRank(b.bucket.status))
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
          </ol>
        </Section>
      )}

      {troubleshooting.length > 0 && (
        <Section
          title="Troubleshooting"
          badgeCount={troubleshooting.reduce((n, g) => n + g.items.length, 0)}
          icon={AlertCircle}
        >
          <p className="mb-2 text-xs text-ink-tertiary">
            Symptom-driven triage. Tap a symptom to expand the cause + remedy;
            rows with a linked procedure offer "Run procedure" inline.
          </p>
          <ol className="flex flex-col gap-3">
            {troubleshooting.map((g) => (
              <TroubleshootingGuideCard
                key={g.guide.id}
                guide={g}
                onRunProcedure={(docId) =>
                  onLaunchProcedure(docId, '', () => void refresh())
                }
              />
            ))}
          </ol>
        </Section>
      )}

      {libraryProcedures.length > 0 && (
        <Section
          title="Procedures"
          badgeCount={libraryProcedures.length}
          icon={ListChecks}
        >
          <p className="mb-2 text-xs text-ink-tertiary">
            Tap any procedure to open it as a Job Aid. PM-scheduled
            procedures live in the sections above.
          </p>
          <ol className="flex flex-col gap-1.5">
            {libraryProcedures.map((p) => (
              <ProcedureRow
                key={p.id}
                doc={p}
                onLaunch={() =>
                  onLaunchProcedure(p.id, '', () => void refresh())
                }
              />
            ))}
          </ol>
        </Section>
      )}

      {data.history.length > 0 && (
        <Section title="History" badgeCount={data.history.length} icon={ClipboardList}>
          <ol className="flex flex-col gap-2">
            {data.history.map((h) => (
              <HistoryRow key={h.id} record={h} />
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}

// Status sort rank — drives ordering in the Checklists section so
// overdue buckets float to the top, "upcoming" sinks to the bottom.
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

// One card per (plan, frequency) bucket. Collapsed by default; tap the
// header to expand the per-row checklist. Each row may carry its own
// procedure link — tapping a row with a procedure launches VirtualJobAid;
// rows without one are reminder-style. "Mark all performed" at the bottom
// posts a single pm_plan_service_record for the whole bucket.
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
    <li
      className="flex flex-col gap-2 rounded-md border bg-surface-raised p-3"
      style={{ borderColor: 'rgb(var(--line))' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-start gap-3 text-left"
      >
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ background: tone.bg, color: tone.text }}
        >
          {tone.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink-primary">
            {planName}{' '}
            <span className="text-ink-tertiary">
              · {bucket.frequencyLabel} checks ({bucket.itemCount})
            </span>
          </div>
          <div className="text-xs text-ink-tertiary">{dueText}</div>
        </div>
        <span className="text-ink-tertiary">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <>
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
        </>
      )}
    </li>
  );
}

// Troubleshooting guide card — guide name as header, each row collapsed
// to just the symptom by default. Tap a row to reveal cause + remedy +
// optional "Run procedure" button. Matches the OEM-table mental model
// the admin authored from but stays scannable on a phone.
function TroubleshootingGuideCard({
  guide,
  onRunProcedure,
}: {
  guide: TroubleshootingGuide;
  onRunProcedure: (docId: string) => void;
}) {
  return (
    <li className="rounded-md border border-line bg-surface-raised">
      <header className="border-b border-line-subtle px-3 py-2">
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
    </li>
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
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-inset"
      >
        <span className="mt-0.5 shrink-0 text-ink-tertiary">
          {open ? '▾' : '▸'}
        </span>
        <span className="flex-1 text-sm font-medium text-ink-primary">
          {item.symptom}
        </span>
        {item.document && (
          <span
            className="shrink-0 text-[10px] uppercase text-brand"
            title="Has linked procedure"
          >
            ▸ Run
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 bg-surface-inset/40 px-3 py-2 pl-8 text-xs">
          {item.cause && (
            <div>
              <div className="font-semibold uppercase text-ink-tertiary text-[10px] tracking-wider">
                Cause
              </div>
              <div className="mt-0.5 text-ink-secondary whitespace-pre-line">
                {item.cause}
              </div>
            </div>
          )}
          {item.remedy && (
            <div>
              <div className="font-semibold uppercase text-ink-tertiary text-[10px] tracking-wider">
                Remedy
              </div>
              <div className="mt-0.5 text-ink-secondary whitespace-pre-line">
                {item.remedy}
              </div>
            </div>
          )}
          {item.document && (
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

// Procedure library row — minimal tappable card. Title + verified chip
// when relevant. Launches VirtualJobAid via the same hook PMs use.
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
        className="flex w-full items-center gap-3 rounded-md border border-line bg-surface-raised px-3 py-2.5 text-left transition hover:border-brand/40 hover:bg-brand/5"
      >
        <ListChecks
          size={16}
          strokeWidth={2}
          className="shrink-0 text-ink-tertiary"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-primary">
          {doc.title}
        </span>
        {isField && (
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase ${
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
            {isUnverified ? '⚠ unverified' : '✓ verified'} · field
          </span>
        )}
        <Play size={14} strokeWidth={2} className="shrink-0 text-brand" />
      </button>
    </li>
  );
}

function Section({
  title,
  icon: Icon,
  badgeCount,
  children,
}: {
  title: string;
  icon: LucideIcon;
  badgeCount?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-2 flex items-center gap-2">
        <Icon size={14} strokeWidth={1.75} className="text-ink-tertiary" />
        <h2 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">
          {title}
        </h2>
        {typeof badgeCount === 'number' && (
          <span className="font-mono text-[10.5px] text-ink-tertiary">
            ({badgeCount})
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

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
    <li
      className="flex flex-col gap-2 rounded-md border bg-surface-raised p-3"
      style={{ borderColor: 'rgb(var(--line))' }}
    >
      <div className="flex items-start gap-3">
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ background: tone.bg, color: tone.text }}
        >
          {tone.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink-primary">
            {schedule.schedule.name}
          </div>
          <div className="text-xs text-ink-tertiary">{dueText}</div>
          {!compact && schedule.schedule.description && (
            <p className="mt-1 text-xs text-ink-secondary">
              {schedule.schedule.description}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-ink-tertiary">
            <span className="flex items-center gap-1">
              <Clock size={10} strokeWidth={1.75} />
              every {schedule.schedule.cadenceValue} day
              {schedule.schedule.cadenceValue === 1 ? '' : 's'}
            </span>
            {schedule.lastPerformedAt && (
              <span>
                Last: {formatNextDue(schedule.lastPerformedAt)}
              </span>
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
              Mark done (no run)
            </button>
          </>
        ) : (
          // Cadence-only PM: no procedure to launch, so the only action
          // is acknowledging the work was performed. Promote it to the
          // primary brand button so the tech doesn't hunt for a "what
          // do I do here?" — there's only one thing to do.
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
    </li>
  );
}

function HistoryRow({ record }: { record: PmServiceRecordItem }) {
  return (
    <li className="rounded-md border border-line-subtle bg-surface-raised p-3 text-sm">
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
    </li>
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
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line bg-surface-raised p-6 text-center">
      <Icon size={28} strokeWidth={1.5} style={{ color }} />
      <p className="text-base font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-sm text-ink-secondary">{body}</p>
    </div>
  );
}
