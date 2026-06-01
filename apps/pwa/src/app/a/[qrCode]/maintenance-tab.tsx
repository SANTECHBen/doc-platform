'use client';

// Field-tech preventive maintenance view for an asset instance.
//
// One question, one screen: "What does the tech need to do next?"
//
//   * Status strip — three quiet counts at the top. Overdue is the
//     only one that can shout (warn-tinted text when > 0).
//   * Today hero — the single most-urgent open task, surfaced as a
//     calm card with one primary button and a quiet acknowledge link.
//     One accent at a time: the status pill carries the urgency, the
//     primary button carries the action. No colored side rail on the
//     hero (the previous design stacked red rail + red pill + red
//     count on the same card).
//   * Browse list — Scheduled / Procedures / Troubleshooting /
//     History as compact rows with subtle counts. Tapping a row
//     expands its slice inline; one slice open at a time. Secondary
//     paths, not peers to the hero.
//
// The 6-tile grid that lived here previously treated every category as
// equal weight and stacked five accent colors onto one screen. Most
// days a tech has one overdue thing — this layout makes that the
// page.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronDown, Clock, Play } from 'lucide-react';
import { useToast } from '@/components/toast';
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
import type { JobAidSource } from '@/components/virtual-job-aid';
import {
  MarkPerformedSheet,
  type MarkableItem,
} from '@/components/mark-performed-sheet';
import {
  planBucketToSteps,
  troubleshootingToSteps,
} from '@/lib/pm-troubleshooting-steps';

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

function formatCadenceDays(days: number): string {
  if (days === 1) return 'daily';
  return `every ${days} days`;
}

// Pill tone per row status. Overdue stays warn (amber) by default; the
// severe-threshold helpers below escalate to alarm-red only when a row
// has blown past a full cadence cycle.
const STATUS_PILL: Record<PmStatus, { label: string; className: string }> = {
  overdue: { label: 'Overdue', className: 'pill pill-warn' },
  due: { label: 'Due', className: 'pill pill-warn' },
  soon: { label: 'Soon', className: 'pill pill-info' },
  upcoming: { label: 'Upcoming', className: 'pill' },
};

// Relative-threshold "severely overdue" check. A daily lube becomes
// severely overdue 2 days late; an annual rebuild only after a year.
function isPmScheduleSevere(s: PmScheduleStatusItem): boolean {
  if (s.status !== 'overdue') return false;
  const cadence = s.schedule.cadenceValue;
  if (!cadence || cadence <= 0) return false;
  return -s.daysUntilDue > cadence;
}

const PLAN_FREQ_DAYS: Record<PmPlanBucket['frequency'], number> = {
  D: 1, W: 7, M: 30, Q: 90, S: 180, Y: 365,
};

function isPmPlanBucketSevere(b: PmPlanBucket): boolean {
  if (b.status !== 'overdue') return false;
  const interval = PLAN_FREQ_DAYS[b.frequency];
  if (!interval) return false;
  return -b.daysUntilDue > interval;
}

// Browse-row keys. Preventive Maintenance (PM plan checklists +
// routine authored procedures) and Removal & Replacement get their
// own rows so a tech replacing a worn part doesn't have to dig
// through inspections to find it.
type FilterKey =
  | 'scheduled'
  | 'pm'
  | 'removal'
  | 'troubleshoot'
  | 'history';

// Back-compat for the parent's deep-link prop. The Overview's PM-due
// tile previously passed 'action'; map any legacy key to its new home.
const LEGACY_FILTER_MAP: Record<string, FilterKey> = {
  action: 'scheduled',
  upcoming: 'scheduled',
  scheduled: 'scheduled',
  walkthroughs: 'pm',
  procedures: 'pm',
  pm: 'pm',
  removal: 'removal',
  troubleshoot: 'troubleshoot',
  history: 'history',
};

// R&R fallback — title-keyword heuristic for legacy procedures with no
// explicit `procedureCategory` set.
const RR_TITLE_RE = /\b(removal|replacement|replace|remove|r&r|swap|rebuild)\b/i;

function isRrProcedure(doc: { title: string; procedureCategory?: string | null }) {
  if (doc.procedureCategory) return doc.procedureCategory === 'removal_replacement';
  return RR_TITLE_RE.test(doc.title);
}

export function MaintenanceTab({
  assetInstanceId,
  versionId,
  fieldCapturesVersionId,
  onLaunchJobAid,
  onChange,
  initialFilter,
}: {
  assetInstanceId: string;
  versionId: string | null;
  fieldCapturesVersionId: string | null;
  /** Mounts a VirtualJobAid for the supplied source (an authored doc or
   *  an inline synthesized step list). `onCompleted` fires when the
   *  tech advances past the last step; ignored on plain close. */
  onLaunchJobAid: (
    source: JobAidSource,
    onCompleted?: () => void,
  ) => void;
  onChange?: () => void;
  /** Optional browse row to expand on mount — Overview's PM-due tile
   *  passes 'scheduled' (or the legacy 'action' which maps to the
   *  same thing) so the tech lands with the queue open. */
  initialFilter?: string;
}) {
  const [data, setData] = useState<PmStatusPayload | null>(null);
  const [planData, setPlanData] = useState<PmPlanStatusPayload | null>(null);
  const [troubleshooting, setTroubleshooting] = useState<TroubleshootingGuide[]>([]);
  const [procedures, setProcedures] = useState<DocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  // One expanded slice at a time. Defaults to null (collapsed) so the
  // page reads as hero-first; the parent can seed a row open via
  // initialFilter when deep-linking from Overview.
  const [expanded, setExpanded] = useState<FilterKey | null>(
    initialFilter ? LEGACY_FILTER_MAP[initialFilter] ?? null : null,
  );
  // Tracks the schedule / plan-bucket whose Mark performed is
  // currently in-flight, so the right button can show a spinner.
  const [marking, setMarking] = useState<string | null>(null);
  // Mark-performed sheet state. Single-item or batch flow. When set,
  // the MarkPerformedSheet renders modally to capture optional notes
  // before the actual API calls fire. `perform` is the closure that
  // runs the API calls with the notes the user typed.
  const [pendingMark, setPendingMark] = useState<{
    items: MarkableItem[];
    perform: (notes: string) => Promise<void>;
  } | null>(null);
  const [markBusy, setMarkBusy] = useState(false);
  // Scroll the expanded row into view so the slice content doesn't
  // appear below the fold on phones.
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

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
    bucketLabel: string,
    notes: string,
  ) {
    const key = `${planId}:${frequency}`;
    setMarking(key);
    try {
      await createPmPlanServiceRecord({
        assetInstanceId,
        planId,
        frequency,
        notes: notes.trim() || null,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      await refresh();
      toast.success(
        `${bucketLabel} marked performed`,
        'Logged to service history.',
      );
    } catch (e) {
      toast.error(
        'Could not mark performed',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setMarking(null);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetInstanceId]);

  useEffect(() => {
    if (expanded && expandedRef.current) {
      expandedRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [expanded]);

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

  // Split the procedure library by R&R heuristic so the Procedures
  // slice can render subheaders without making R&R its own browse row.
  const rrProcedures = useMemo(
    () => libraryProcedures.filter((p) => isRrProcedure(p)),
    [libraryProcedures],
  );
  const nonRrProcedures = useMemo(
    () => libraryProcedures.filter((p) => !isRrProcedure(p)),
    [libraryProcedures],
  );

  if (error) {
    return (
      <p
        className="rounded-md border p-3 text-sm"
        style={{
          borderColor: 'rgba(var(--signal-fault) / 0.45)',
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

  const dueNow = data.schedules
    .filter((s) => s.needsAction)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
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

  // Counts surfaced in the status strip and browse rows.
  const overdueCount = dueNow.length + overdueBuckets.length;
  const upcomingCount = upcoming.length + upcomingBuckets.length;
  const scheduledTotal = overdueCount + upcomingCount;
  // Preventive Maintenance = PM checklists + non-R&R authored
  // procedures (routine inspections, calibrations, diagnostics).
  // R&R lives on its own row.
  const pmTotal = allBuckets.length + nonRrProcedures.length;
  const removalTotal = rrProcedures.length;
  // Headline number for the status strip — every authored or
  // scheduled procedure surface on this asset.
  const proceduresTotal = allBuckets.length + libraryProcedures.length;

  const anyMaintenance =
    data.schedules.length > 0 ||
    allBuckets.length > 0 ||
    troubleshooting.length > 0;
  const nothingScheduled = !anyMaintenance;

  async function logServicePerformed(s: PmScheduleStatusItem, notes: string) {
    setMarking(s.schedule.id);
    try {
      await createPmServiceRecord({
        assetInstanceId,
        pmScheduleId: s.schedule.id,
        documentId: s.schedule.document?.id ?? null,
        notes: notes.trim() || null,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      await refresh();
      toast.success(
        `${s.schedule.name} marked performed`,
        'Logged to service history.',
      );
    } catch (e) {
      toast.error(
        'Could not mark performed',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setMarking(null);
    }
  }

  // Open the evidence-capture sheet for a single schedule. The sheet's
  // onConfirm callback runs the actual log call with whatever notes
  // the tech typed in.
  function openMarkScheduleSheet(s: PmScheduleStatusItem) {
    setPendingMark({
      items: [{ key: `schedule:${s.schedule.id}`, label: s.schedule.name }],
      perform: (notes) => logServicePerformed(s, notes),
    });
  }
  function openMarkBucketSheet(
    plan: { id: string; name: string },
    bucket: PmPlanBucket,
  ) {
    setPendingMark({
      items: [
        {
          key: `bucket:${plan.id}:${bucket.frequency}`,
          label: `${plan.name} · ${bucket.frequencyLabel}`,
        },
      ],
      perform: (notes) =>
        logPlanPerformed(
          plan.id,
          bucket.frequency,
          `${plan.name} · ${bucket.frequencyLabel}`,
          notes,
        ),
    });
  }
  // Batch flow — "Mark all due performed" at the top of the Scheduled
  // slice opens the sheet with all overdue schedules + buckets at
  // once. One notes value applies to every record (the tech is
  // attesting "I did all of these"); the actual API calls fire in
  // parallel.
  function openMarkAllDueSheet() {
    const scheduleItems = dueNow.map((s) => ({
      key: `schedule:${s.schedule.id}`,
      label: s.schedule.name,
      perform: (notes: string) => logServicePerformed(s, notes),
    }));
    const bucketItems = overdueBuckets.map((row) => ({
      key: `bucket:${row.plan.id}:${row.bucket.frequency}`,
      label: `${row.plan.name} · ${row.bucket.frequencyLabel}`,
      perform: (notes: string) =>
        logPlanPerformed(
          row.plan.id,
          row.bucket.frequency,
          `${row.plan.name} · ${row.bucket.frequencyLabel}`,
          notes,
        ),
    }));
    const combined = [...scheduleItems, ...bucketItems];
    if (combined.length === 0) return;
    setPendingMark({
      items: combined.map((it) => ({ key: it.key, label: it.label })),
      perform: async (notes) => {
        await Promise.all(combined.map((it) => it.perform(notes)));
      },
    });
  }
  async function onConfirmMark(notes: string) {
    if (!pendingMark) return;
    setMarkBusy(true);
    try {
      await pendingMark.perform(notes);
    } finally {
      setMarkBusy(false);
      setPendingMark(null);
    }
  }

  function launchDoc(docId: string, onCompleted?: () => void) {
    onLaunchJobAid(
      { kind: 'doc', docId, devUserId: DEV_USER_ID, devOrgId: DEV_ORG_ID },
      onCompleted,
    );
  }
  function launchInline(
    title: string,
    steps: Array<{
      title: string;
      bodyMarkdown?: string | null;
      safetyCritical?: boolean;
    }>,
    onCompleted?: () => void,
  ) {
    if (steps.length === 0) return;
    onLaunchJobAid({ kind: 'inline', title, steps }, onCompleted);
  }

  // The single item the hero promotes. Severely-overdue rows beat
  // ordinary-overdue rows; within each tier the most-overdue (most
  // negative daysUntilDue) wins.
  type Hero =
    | { kind: 'schedule'; item: PmScheduleStatusItem }
    | {
        kind: 'bucket';
        plan: { id: string; name: string };
        bucket: PmPlanBucket;
      };
  const heroItem: Hero | null = (() => {
    type Ranked = { hero: Hero; severeTier: number; daysUntilDue: number };
    const all: Ranked[] = [];
    for (const s of dueNow) {
      all.push({
        hero: { kind: 'schedule', item: s },
        severeTier: isPmScheduleSevere(s) ? 0 : 1,
        daysUntilDue: s.daysUntilDue,
      });
    }
    for (const row of overdueBuckets) {
      all.push({
        hero: { kind: 'bucket', plan: row.plan, bucket: row.bucket },
        severeTier: isPmPlanBucketSevere(row.bucket) ? 0 : 1,
        daysUntilDue: row.bucket.daysUntilDue,
      });
    }
    if (all.length === 0) return null;
    all.sort((a, b) =>
      a.severeTier !== b.severeTier
        ? a.severeTier - b.severeTier
        : a.daysUntilDue - b.daysUntilDue,
    );
    return all[0]!.hero;
  })();

  // Empty-state "Next:" preview pulled from upcoming schedules + buckets.
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

  if (nothingScheduled && libraryProcedures.length === 0) {
    return (
      <div className="maintenance-page">
        <EmptyState
          title="No PM schedules for this model"
          body="An admin can author PM schedules from the asset model detail page. Once added, every instance of this model — including this one — will see what's due here."
        />
      </div>
    );
  }

  // Snapshot history out of the (now-narrowed) data payload — captured
  // by closure inside renderSlice, where TS can't carry the narrowing.
  const historyRecords = data.history;

  const browseRows: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: 'scheduled', label: 'Scheduled', count: scheduledTotal },
    { key: 'pm', label: 'Preventive Maintenance', count: pmTotal },
    { key: 'removal', label: 'Removal & Replacement', count: removalTotal },
    { key: 'troubleshoot', label: 'Troubleshooting', count: troubleshootingTotal },
    { key: 'history', label: 'History', count: historyRecords.length },
  ];

  // Number of items eligible for the "Mark all due performed" batch
  // button. Promotes the batch affordance only when there are at
  // least 2 due items — for a single item the regular card-level
  // Mark Performed is already a one-tap path.
  const allDueCount = dueNow.length + overdueBuckets.length;

  function renderSlice(key: FilterKey): ReactNode {
    switch (key) {
      case 'scheduled': {
        if (scheduledTotal === 0) {
          return (
            <SliceEmpty
              title="Nothing scheduled"
              body="No PM in the planning window for this asset."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2">
            {allDueCount >= 2 && (
              <button
                type="button"
                onClick={openMarkAllDueSheet}
                className="maint-batch-mark"
                aria-label={`Mark all ${allDueCount} due PMs as performed`}
              >
                <Check size={14} strokeWidth={2.25} aria-hidden />
                Mark all {allDueCount} due as performed
              </button>
            )}
            {dueNow.map((s) => (
              <ScheduleCard
                key={s.schedule.id}
                schedule={s}
                marking={marking === s.schedule.id}
                onRunProcedure={() => {
                  if (!s.schedule.document) {
                    toast.error(
                      'No procedure attached',
                      'Attach a procedure to this PM schedule in the admin console.',
                    );
                    return;
                  }
                  launchDoc(s.schedule.document.id, () => void refresh());
                }}
                onMarkDone={() => openMarkScheduleSheet(s)}
              />
            ))}
            {overdueBuckets
              .slice()
              .sort(
                (a, b) => statusRank(a.bucket.status) - statusRank(b.bucket.status),
              )
              .map((row) => (
                <PlanBucketCard
                  key={`${row.plan.id}:${row.bucket.frequency}`}
                  planName={row.plan.name}
                  bucket={row.bucket}
                  marking={marking === `${row.plan.id}:${row.bucket.frequency}`}
                  onRun={() =>
                    launchInline(
                      `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                      planBucketToSteps(row.bucket),
                      () =>
                        void logPlanPerformed(
                          row.plan.id,
                          row.bucket.frequency,
                          `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                          '',
                        ),
                    )
                  }
                  onMarkPerformed={() => openMarkBucketSheet(row.plan, row.bucket)}
                />
              ))}
            {upcoming.map((s) => (
              <ScheduleCard
                key={s.schedule.id}
                schedule={s}
                compact
                marking={marking === s.schedule.id}
                onRunProcedure={() => {
                  if (!s.schedule.document) {
                    toast.error(
                      'No procedure attached',
                      'Attach a procedure to this PM schedule in the admin console.',
                    );
                    return;
                  }
                  launchDoc(s.schedule.document.id, () => void refresh());
                }}
                onMarkDone={() => openMarkScheduleSheet(s)}
              />
            ))}
            {upcomingBuckets
              .slice()
              .sort((a, b) => a.bucket.daysUntilDue - b.bucket.daysUntilDue)
              .map((row) => (
                <PlanBucketCard
                  key={`${row.plan.id}:${row.bucket.frequency}`}
                  planName={row.plan.name}
                  bucket={row.bucket}
                  marking={marking === `${row.plan.id}:${row.bucket.frequency}`}
                  onRun={() =>
                    launchInline(
                      `${row.plan.name} - ${row.bucket.frequencyLabel}`,
                      planBucketToSteps(row.bucket),
                      () =>
                        void logPlanPerformed(
                          row.plan.id,
                          row.bucket.frequency,
                          `${row.plan.name} - ${row.bucket.frequencyLabel}`,
                          '',
                        ),
                    )
                  }
                  onMarkPerformed={() => openMarkBucketSheet(row.plan, row.bucket)}
                />
              ))}
          </div>
        );
      }
      case 'pm': {
        // PM plan checklists + non-R&R authored procedures
        // (inspections / calibrations / diagnostics — the routine
        // recurring work). R&R has its own row below.
        if (allBuckets.length === 0 && nonRrProcedures.length === 0) {
          return (
            <SliceEmpty
              title="No preventive maintenance"
              body="No PM checklists or routine procedures for this model yet."
            />
          );
        }
        return (
          <div className="flex flex-col gap-4">
            {allBuckets.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="cap">PM checklists · grouped by frequency</p>
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
                      marking={marking === `${row.plan.id}:${row.bucket.frequency}`}
                      onRun={() =>
                        launchInline(
                          `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                          planBucketToSteps(row.bucket),
                          () =>
                            void logPlanPerformed(
                              row.plan.id,
                              row.bucket.frequency,
                              `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                              '',
                            ),
                        )
                      }
                      onMarkPerformed={() => openMarkBucketSheet(row.plan, row.bucket)}
                    />
                  ))}
              </div>
            )}
            {nonRrProcedures.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="cap">Procedures · run on demand</p>
                <ul className="flex flex-col">
                  {nonRrProcedures.map((p) => (
                    <ProcedureRow
                      key={p.id}
                      doc={p}
                      onLaunch={() => launchDoc(p.id)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      }
      case 'removal': {
        if (rrProcedures.length === 0) {
          return (
            <SliceEmpty
              title="No removal & replacement procedures"
              body="None authored for this asset model yet."
            />
          );
        }
        return (
          <ul className="flex flex-col">
            {rrProcedures.map((p) => (
              <ProcedureRow
                key={p.id}
                doc={p}
                onLaunch={() => launchDoc(p.id)}
              />
            ))}
          </ul>
        );
      }
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
            {troubleshooting.map((g) => (
              <TroubleshootingGuideCard
                key={g.guide.id}
                guide={g}
                onRunItem={(item) => {
                  const inlineSteps = troubleshootingToSteps(item);
                  if (inlineSteps.length > 0) {
                    launchInline(item.symptom, inlineSteps);
                    return;
                  }
                  if (item.document) {
                    launchDoc(item.document.id);
                  }
                }}
              />
            ))}
          </div>
        );
      case 'history':
        if (historyRecords.length === 0) {
          return (
            <SliceEmpty
              title="No service history yet"
              body="Once maintenance is logged on this asset, you'll see it here."
            />
          );
        }
        return (
          <div className="flex flex-col gap-2">
            {historyRecords.map((h) => (
              <HistoryRow key={h.id} record={h} />
            ))}
          </div>
        );
    }
  }

  return (
    <div className="maintenance-page">
      <StatusStrip
        overdueCount={overdueCount}
        upcomingCount={upcomingCount}
        proceduresCount={proceduresTotal}
      />

      {heroItem ? (
        <HeroCard
          item={heroItem}
          marking={marking}
          extraCount={overdueCount - 1}
          onOpenScheduled={() => setExpanded('scheduled')}
          onRunSchedule={(s) => {
            if (!s.schedule.document) {
              toast.error(
                'No procedure attached',
                'Attach a procedure to this PM schedule in the admin console.',
              );
              return;
            }
            launchDoc(s.schedule.document.id, () => void refresh());
          }}
          onMarkSchedule={(s) => openMarkScheduleSheet(s)}
          onRunBucket={(plan, bucket) =>
            launchInline(
              `${plan.name} · ${bucket.frequencyLabel}`,
              planBucketToSteps(bucket),
              () =>
                void logPlanPerformed(
                  plan.id,
                  bucket.frequency,
                  `${plan.name} · ${bucket.frequencyLabel}`,
                  '',
                ),
            )
          }
          onMarkBucket={(plan, bucket) => openMarkBucketSheet(plan, bucket)}
        />
      ) : (
        <HeroEmpty nextItem={nextItem} />
      )}

      <section className="maint-browse" aria-labelledby="maint-browse-h">
        <h3 id="maint-browse-h" className="maint-browse-h">Browse</h3>
        <div className="maint-browse-list">
          {browseRows.map((row) => {
            const isOpen = expanded === row.key;
            return (
              <div
                key={row.key}
                className="maint-browse-item"
                data-expanded={isOpen ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="maint-browse-row"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : row.key)}
                >
                  <span className="maint-browse-row-label">{row.label}</span>
                  <span className="maint-browse-row-count">{row.count}</span>
                  <ChevronDown
                    className="maint-browse-row-chevron"
                    size={16}
                    strokeWidth={2}
                    aria-hidden
                  />
                </button>
                {isOpen && (
                  <div className="maint-browse-content" ref={expandedRef}>
                    {renderSlice(row.key)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {pendingMark && (
        <MarkPerformedSheet
          items={pendingMark.items}
          busy={markBusy}
          onClose={() => {
            if (!markBusy) setPendingMark(null);
          }}
          onConfirm={(notes) => void onConfirmMark(notes)}
        />
      )}
    </div>
  );
}

// ─── header ────────────────────────────────────────────────────────
function StatusStrip({
  overdueCount,
  upcomingCount,
  proceduresCount,
}: {
  overdueCount: number;
  upcomingCount: number;
  proceduresCount: number;
}) {
  return (
    <header className="maint-header">
      <h2 className="maint-header-title">Maintenance</h2>
      <p className="maint-status-strip">
        <span
          className="maint-status-metric"
          data-tone={overdueCount > 0 ? 'warn' : 'idle'}
        >
          <strong>{overdueCount}</strong> overdue
        </span>
        <span className="maint-status-sep" aria-hidden>·</span>
        <span className="maint-status-metric">
          <strong>{upcomingCount}</strong> upcoming
        </span>
        <span className="maint-status-sep" aria-hidden>·</span>
        <span className="maint-status-metric">
          <strong>{proceduresCount}</strong> procedures
        </span>
      </p>
    </header>
  );
}

// ─── hero ──────────────────────────────────────────────────────────
type HeroProps = {
  item:
    | { kind: 'schedule'; item: PmScheduleStatusItem }
    | { kind: 'bucket'; plan: { id: string; name: string }; bucket: PmPlanBucket };
  marking: string | null;
  /** Items past this one — surfaces a quiet "+N more" link to Scheduled. */
  extraCount: number;
  onOpenScheduled: () => void;
  onRunSchedule: (s: PmScheduleStatusItem) => void;
  onMarkSchedule: (s: PmScheduleStatusItem) => void;
  onRunBucket: (
    plan: { id: string; name: string },
    bucket: PmPlanBucket,
  ) => void;
  onMarkBucket: (
    plan: { id: string; name: string },
    bucket: PmPlanBucket,
  ) => void;
};

function HeroCard(props: HeroProps) {
  const { item, marking } = props;

  if (item.kind === 'schedule') {
    const s = item.item;
    const severe = isPmScheduleSevere(s);
    const basePill = STATUS_PILL[s.status];
    const pill = severe
      ? { label: 'Overdue', className: 'pill pill-alarm' }
      : basePill;
    const when =
      s.status === 'overdue'
        ? `Overdue ${formatDaysUntil(s.daysUntilDue)}`
        : s.status === 'due'
          ? 'Due today'
          : `Due ${formatDaysUntil(s.daysUntilDue)} · ${formatNextDue(s.nextDueAt)}`;
    const subtitleParts: string[] = [];
    if (s.schedule.description) subtitleParts.push(s.schedule.description);
    subtitleParts.push(formatCadenceDays(s.schedule.cadenceValue));
    if (s.lastPerformedAt) {
      subtitleParts.push(`last ${formatNextDue(s.lastPerformedAt)}`);
    }
    const isMarking = marking === s.schedule.id;
    const hasDoc = !!s.schedule.document;
    return (
      <HeroShell
        pillLabel={pill.label}
        pillClass={pill.className}
        whenText={when}
        title={s.schedule.name}
        subtitle={subtitleParts.join(' · ')}
        primaryLabel={hasDoc ? 'Run procedure' : 'Mark performed'}
        primaryIcon={
          hasDoc ? (
            <Play size={15} strokeWidth={2.25} />
          ) : (
            <Check size={15} strokeWidth={2.25} />
          )
        }
        primaryLoading={!hasDoc && isMarking}
        onPrimary={() =>
          hasDoc ? props.onRunSchedule(s) : props.onMarkSchedule(s)
        }
        secondary={
          hasDoc
            ? {
                label: isMarking ? 'Marking…' : 'Mark performed',
                onClick: () => props.onMarkSchedule(s),
                disabled: isMarking,
              }
            : null
        }
        extraCount={props.extraCount}
        onOpenScheduled={props.onOpenScheduled}
      />
    );
  }

  const { plan, bucket } = item;
  const severe = isPmPlanBucketSevere(bucket);
  const basePill = STATUS_PILL[bucket.status];
  const pill = severe
    ? { label: 'Overdue', className: 'pill pill-alarm' }
    : basePill;
  const when =
    bucket.status === 'overdue'
      ? `Overdue ${formatDaysUntil(bucket.daysUntilDue)}`
      : bucket.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(bucket.daysUntilDue)} · ${formatNextDue(bucket.nextDueAt)}`;
  const subtitle = `${bucket.itemCount} checklist item${
    bucket.itemCount === 1 ? '' : 's'
  } · ${bucket.frequencyLabel}`;
  const isMarking = marking === `${plan.id}:${bucket.frequency}`;
  return (
    <HeroShell
      pillLabel={pill.label}
      pillClass={pill.className}
      whenText={when}
      title={plan.name}
      subtitle={subtitle}
      primaryLabel="Start checklist"
      primaryIcon={<Play size={15} strokeWidth={2.25} />}
      onPrimary={() => props.onRunBucket(plan, bucket)}
      secondary={{
        label: isMarking ? 'Marking…' : 'Mark performed',
        onClick: () => props.onMarkBucket(plan, bucket),
        disabled: isMarking,
      }}
      extraCount={props.extraCount}
      onOpenScheduled={props.onOpenScheduled}
    />
  );
}

function HeroShell({
  pillLabel,
  pillClass,
  whenText,
  title,
  subtitle,
  primaryLabel,
  primaryIcon,
  primaryLoading,
  onPrimary,
  secondary,
  extraCount,
  onOpenScheduled,
}: {
  pillLabel: string;
  pillClass: string;
  whenText: string;
  title: string;
  subtitle: string;
  primaryLabel: string;
  primaryIcon: ReactNode;
  primaryLoading?: boolean;
  onPrimary: () => void;
  secondary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  } | null;
  extraCount: number;
  onOpenScheduled: () => void;
}) {
  return (
    <article className="maint-hero">
      <header className="maint-hero-head">
        <span className={pillClass}>{pillLabel}</span>
        <span className="maint-hero-when">{whenText}</span>
      </header>
      <h3 className="maint-hero-title">{title}</h3>
      <p className="maint-hero-subtitle">{subtitle}</p>
      <div className="maint-hero-actions">
        <button
          type="button"
          onClick={onPrimary}
          className={`btn btn-primary btn-lg maint-hero-primary ${primaryLoading ? 'btn-loading' : ''}`}
        >
          {primaryIcon}
          {primaryLabel}
        </button>
        {secondary && (
          <button
            type="button"
            onClick={secondary.onClick}
            disabled={secondary.disabled}
            className="maint-hero-ack"
          >
            <Check size={14} strokeWidth={2} aria-hidden />
            {secondary.label}
          </button>
        )}
      </div>
      {extraCount > 0 && (
        <button
          type="button"
          onClick={onOpenScheduled}
          className="maint-hero-more"
        >
          +{extraCount} more in Scheduled
        </button>
      )}
    </article>
  );
}

function HeroEmpty({
  nextItem,
}: {
  nextItem: { label: string; days: number } | null;
}) {
  return (
    <article className="maint-hero maint-hero-empty">
      <p className="maint-hero-empty-title">All caught up</p>
      <p className="maint-hero-empty-body">
        {nextItem
          ? `Next: ${nextItem.label} ${formatDaysUntil(nextItem.days)}.`
          : 'No PM in the planning window.'}
      </p>
    </article>
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

// ─── shared row components used inside expanded slices ────────────
// Same chrome as before — these only render inside the Scheduled /
// Procedures slices now, never at top level. The hero owns its own
// quieter card so the heavy task-card treatment is contained.

function ScheduleCard({
  schedule,
  compact,
  marking,
  onRunProcedure,
  onMarkDone,
}: {
  schedule: PmScheduleStatusItem;
  compact?: boolean;
  marking: boolean;
  onRunProcedure: () => void;
  onMarkDone: () => void;
}) {
  const severe = isPmScheduleSevere(schedule);
  const basePill = STATUS_PILL[schedule.status];
  const pill = severe
    ? { label: 'Overdue', className: 'pill pill-alarm' }
    : basePill;
  const dueText =
    schedule.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(schedule.daysUntilDue)}`
      : schedule.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(schedule.daysUntilDue)} (${formatNextDue(schedule.nextDueAt)})`;

  return (
    <div
      className="maintenance-task-card"
      data-status={schedule.status}
      data-severe={severe ? 'true' : undefined}
    >
      <div className="task-card-status">
        <span className={pill.className}>{pill.label}</span>
        <span className="text-[12px] text-ink-tertiary">{dueText}</span>
      </div>
      <div className="task-card-title-block">
        <div className="task-card-name">{schedule.schedule.name}</div>
        {!compact && schedule.schedule.description && (
          <p className="task-card-description">{schedule.schedule.description}</p>
        )}
        <div className="task-card-cadence">
          <span className="inline-flex items-center gap-1">
            <Clock size={11} strokeWidth={1.75} />
            {formatCadenceDays(schedule.schedule.cadenceValue)}
          </span>
          {schedule.lastPerformedAt && (
            <span>Last {formatNextDue(schedule.lastPerformedAt)}</span>
          )}
        </div>
      </div>
      <div className="maintenance-card-actions">
        {schedule.schedule.document ? (
          <>
            <button
              type="button"
              onClick={onRunProcedure}
              className="btn btn-primary"
            >
              <Play size={13} strokeWidth={2.25} />
              Run procedure
            </button>
            <button
              type="button"
              onClick={onMarkDone}
              disabled={marking}
              className={`btn btn-secondary ${marking ? 'btn-loading' : ''}`}
            >
              {marking ? 'Marking…' : 'Mark done'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onMarkDone}
            disabled={marking}
            className={`btn btn-primary ${marking ? 'btn-loading' : ''}`}
          >
            {marking ? 'Marking…' : 'Mark performed'}
          </button>
        )}
      </div>
    </div>
  );
}

function PlanBucketCard({
  planName,
  bucket,
  marking,
  onRun,
  onMarkPerformed,
}: {
  planName: string;
  bucket: PmPlanBucket;
  marking: boolean;
  onRun: () => void;
  onMarkPerformed: () => void;
}) {
  const severe = isPmPlanBucketSevere(bucket);
  const basePill = STATUS_PILL[bucket.status];
  const pill = severe
    ? { label: 'Overdue', className: 'pill pill-alarm' }
    : basePill;
  const dueText =
    bucket.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(bucket.daysUntilDue)}`
      : bucket.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(bucket.daysUntilDue)} (${formatNextDue(bucket.nextDueAt)})`;

  return (
    <div
      className="maintenance-task-card"
      data-status={bucket.status}
      data-severe={severe ? 'true' : undefined}
    >
      <div className="task-card-status">
        <span className={pill.className}>{pill.label}</span>
        <span className="text-[12px] text-ink-tertiary">{dueText}</span>
      </div>
      <div className="task-card-title-block">
        <div className="task-card-plan">{planName}</div>
        <div className="task-card-frequency">{bucket.frequencyLabel}</div>
        <div className="task-card-itemcount">
          {bucket.itemCount} item{bucket.itemCount === 1 ? '' : 's'}
        </div>
      </div>
      <div className="maintenance-card-actions">
        <button type="button" onClick={onRun} className="btn btn-primary">
          <Play size={13} strokeWidth={2.25} />
          Start checklist
        </button>
        <button
          type="button"
          onClick={onMarkPerformed}
          disabled={marking}
          className={`btn btn-secondary ${marking ? 'btn-loading' : ''}`}
        >
          {marking ? 'Marking…' : 'Mark performed'}
        </button>
      </div>
    </div>
  );
}

function TroubleshootingGuideCard({
  guide,
  onRunItem,
}: {
  guide: TroubleshootingGuide;
  onRunItem: (item: TroubleshootingGuide['items'][number]) => void;
}) {
  return (
    <div className="maintenance-guide-card">
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
          <TroubleshootingRow key={it.id} item={it} onRun={() => onRunItem(it)} />
        ))}
      </ul>
    </div>
  );
}

function TroubleshootingRow({
  item,
  onRun,
}: {
  item: TroubleshootingGuide['items'][number];
  onRun: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onRun}
        className="flex w-full items-center gap-3 px-3 py-3 text-left"
      >
        <span className="flex-1 text-sm font-medium text-ink-primary">
          {item.symptom}
        </span>
        <Play
          size={14}
          strokeWidth={2}
          className="shrink-0 text-ink-tertiary"
        />
      </button>
    </li>
  );
}

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
  const kindLabel = record.pmSchedule
    ? 'SCHEDULE'
    : record.pmPlan
      ? 'PM PLAN'
      : record.procedureRun?.category === 'removal_replacement'
        ? 'R&R'
        : record.procedureRun?.category === 'troubleshooting'
          ? 'TROUBLESHOOT'
          : 'AD-HOC';
  const title = record.pmSchedule?.name
    ?? (record.pmPlan
      ? `${record.pmPlan.name} · ${record.pmPlan.frequencyLabel}`
      : record.procedureRun
        ? record.document?.title ?? null
        : null);
  return (
    <div className="maintenance-history-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="cap" style={{ color: 'rgb(var(--ink-tertiary))' }}>
            {kindLabel}
          </span>
          <div className="font-medium text-ink-primary">
            {title ?? (
              <span className="italic text-ink-tertiary">Ad-hoc service</span>
            )}
          </div>
          {record.document && !record.procedureRun && (
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
          <div>{record.performedBy?.displayName ?? 'Field tech'}</div>
        </div>
      </div>
    </div>
  );
}

function SliceEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="maintenance-empty maintenance-empty-compact">
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-xs text-ink-secondary">{body}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="maintenance-empty">
      <p className="text-base font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-sm text-ink-secondary">{body}</p>
    </div>
  );
}
