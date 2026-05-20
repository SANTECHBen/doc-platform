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
import {
  AlertTriangle,
  CalendarClock,
  Clock,
  History,
  ListChecks,
  Play,
  RotateCcw,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
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

// The category cards drive a slice below them. Nothing renders below
// the grid until the tech taps a card — the prior "auto-pin Action
// open" behavior was confusing alongside the Overview's PM Due count
// (different totals depending on data source) and made the cards feel
// like decoration rather than the navigation.
type FilterKey =
  | 'action'
  | 'upcoming'
  | 'walkthroughs'
  | 'removal'
  | 'troubleshoot'
  | 'history';

// R&R heuristic — a procedure is treated as "Removal & Replacement"
// when its title contains any of these tokens (case-insensitive).
// Authoring doesn't (yet) categorize procedures explicitly; this is
// the pragmatic shortcut until it does. Keep the regex deliberately
// narrow so a "Daily inspection" doesn't accidentally match "replace
// the safety guards" prose.
const RR_TITLE_RE = /\b(removal|replacement|replace|remove|r&r|swap|rebuild)\b/i;

export function MaintenanceTab({
  assetInstanceId,
  versionId,
  fieldCapturesVersionId,
  onLaunchJobAid,
  onChange,
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
}) {
  const [data, setData] = useState<PmStatusPayload | null>(null);
  const [planData, setPlanData] = useState<PmPlanStatusPayload | null>(null);
  const [troubleshooting, setTroubleshooting] = useState<TroubleshootingGuide[]>([]);
  const [procedures, setProcedures] = useState<DocumentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Nothing selected by default — the cards are the navigation. A
  // tech tapping any card reveals its slice below. This avoids the
  // "automatic overdue list" failure mode where overdue items
  // appeared without intent and made the grid look like a header.
  const [active, setActive] = useState<FilterKey | null>(null);
  // Tracks the schedule / plan-bucket whose Mark performed is
  // currently in-flight, so the right button can show a spinner.
  // Keyed by schedule.id or `${planId}:${frequency}` for buckets.
  const [marking, setMarking] = useState<string | null>(null);
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
  ) {
    const key = `${planId}:${frequency}`;
    setMarking(key);
    try {
      await createPmPlanServiceRecord({
        assetInstanceId,
        planId,
        frequency,
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

  // Split the procedure library by R&R heuristic. R&R procedures get
  // their own card so a tech replacing a worn part doesn't dig through
  // a mixed Walkthroughs list; the remainder (inspections, diagnostics,
  // calibrations etc.) stays in Walkthroughs.
  const rrProcedures = useMemo(
    () => libraryProcedures.filter((p) => RR_TITLE_RE.test(p.title)),
    [libraryProcedures],
  );
  const nonRrProcedures = useMemo(
    () => libraryProcedures.filter((p) => !RR_TITLE_RE.test(p.title)),
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
    // No identity gate — writes go through the scan session and are
    // attributed as "Field tech" server-side. When strict per-tech
    // sign-in is wired (admin-toggleable, future), this is where the
    // AuthPrompt fallback returns.
    setMarking(s.schedule.id);
    try {
      await createPmServiceRecord({
        assetInstanceId,
        pmScheduleId: s.schedule.id,
        documentId: s.schedule.document?.id ?? null,
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

  // Local helpers that adapt callers (cards / rows) to the unified
  // onLaunchJobAid surface. `launchDoc` wraps an authored procedure;
  // `launchInline` synthesizes the click-through step list from data
  // we already have in hand (plan checklist, troubleshooting causes).
  function launchDoc(docId: string, onCompleted?: () => void) {
    onLaunchJobAid(
      {
        kind: 'doc',
        docId,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      },
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

  // Card grid. Six cards arranged 2×3 (phone) or 3×2 (tablet). Action
  // is back IN the grid (no longer pinned above) per UX feedback —
  // cards are the navigation, the slice content only reveals on tap.
  // Walkthroughs holds PM checklists + non-R&R procedures (inspections
  // / diagnostics / calibrations); R&R has its own card so a tech
  // replacing a worn part doesn't dig through a mixed list.
  const walkthroughCount = allBuckets.length + nonRrProcedures.length;
  const cards: CategoryCard[] = [
    {
      key: 'action',
      label: 'Action',
      count: actionCount,
      // Binary tone — anything actionable reads red, otherwise green.
      // The earlier 3-way (fault / warn / ok) gave the warn case an
      // amber/brown tint that didn't pull weight; "needs action" is
      // already a single-axis signal, no need to split it.
      tone: actionCount === 0 ? 'ok' : 'fault',
      subtitle:
        actionCount === 0
          ? 'All caught up'
          : [
              overdueCount > 0 ? `${overdueCount} overdue` : null,
              dueTodayCount > 0 ? `${dueTodayCount} due today` : null,
            ]
              .filter(Boolean)
              .join(' · '),
      icon: AlertTriangle,
    },
    {
      key: 'upcoming',
      label: 'Upcoming',
      count: upcoming.length,
      tone: 'idle',
      subtitle: nextItem
        ? `Next ${formatDaysUntil(nextItem.days)}`
        : 'None scheduled',
      icon: CalendarClock,
    },
    {
      key: 'walkthroughs',
      label: 'Preventive Maintenance',
      count: walkthroughCount,
      tone: 'idle',
      subtitle:
        walkthroughCount === 0
          ? 'None authored'
          : `${allBuckets.length} checklist${allBuckets.length === 1 ? '' : 's'} · ${nonRrProcedures.length} procedure${nonRrProcedures.length === 1 ? '' : 's'}`,
      icon: ListChecks,
    },
    {
      key: 'removal',
      label: 'Removal & Replace',
      count: rrProcedures.length,
      tone: 'idle',
      subtitle:
        rrProcedures.length === 0
          ? 'None authored'
          : 'Tap to run',
      icon: RotateCcw,
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
      icon: ShieldAlert,
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
      icon: History,
    },
  ];

  const slice = (() => {
    if (active === null) return null;
    switch (active) {
      case 'action': {
        if (actionCount === 0) {
          return (
            <SliceEmpty
              title="Nothing needs action"
              body={
                nextItem
                  ? `Next: "${nextItem.label}" ${formatDaysUntil(nextItem.days)}.`
                  : 'Check back later or pick another card.'
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
                  marking={
                    marking === `${row.plan.id}:${row.bucket.frequency}`
                  }
                  onRun={() =>
                    launchInline(
                      `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                      planBucketToSteps(row.bucket),
                      () =>
                        void logPlanPerformed(
                          row.plan.id,
                          row.bucket.frequency,
                          `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                        ),
                    )
                  }
                  onMarkPerformed={() =>
                    void logPlanPerformed(
                      row.plan.id,
                      row.bucket.frequency,
                      `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                    )
                  }
                />
              ))}
          </div>
        );
      }
      case 'removal':
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
                onMarkDone={() => void logServicePerformed(s)}
              />
            ))}
          </div>
        );
      case 'walkthroughs': {
        // PM plan checklists + non-R&R authored procedures. R&R
        // procedures (removal / replacement / swap / rebuild titles)
        // live in their own card; everything else routine —
        // inspections, calibrations, diagnostics — surfaces here.
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
                      marking={
                        marking === `${row.plan.id}:${row.bucket.frequency}`
                      }
                      onRun={() =>
                        launchInline(
                          `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                          planBucketToSteps(row.bucket),
                          () =>
                            void logPlanPerformed(
                              row.plan.id,
                              row.bucket.frequency,
                              `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                            ),
                        )
                      }
                      onMarkPerformed={() =>
                        void logPlanPerformed(
                          row.plan.id,
                          row.bucket.frequency,
                          `${row.plan.name} · ${row.bucket.frequencyLabel}`,
                        )
                      }
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
                onRunItem={(item) => {
                  // Each symptom is its own click-through job-aid.
                  // If the row has a single linked procedure and no
                  // structured cause/remedy data, launch that doc
                  // directly — otherwise synthesize inline steps from
                  // the structured causes / remedies.
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
            onSelect={(k) => setActive((cur) => (cur === k ? null : k))}
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
type CategoryTone = 'fault' | 'warn' | 'ok' | 'idle';

type CategoryCard = {
  key: FilterKey;
  label: string;
  count: number;
  tone: CategoryTone;
  subtitle: string;
  /** Category glyph rendered in the card's corner. Gives each card
   *  a distinct silhouette so techs can pattern-match without
   *  reading the label first. */
  icon: LucideIcon;
};

function CategoryGrid({
  cards,
  active,
  onSelect,
}: {
  cards: CategoryCard[];
  active: FilterKey | null;
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
  const Icon = card.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-tone={card.tone}
      data-active={active ? 'true' : 'false'}
      className="cat-card"
    >
      {/* Category glyph anchored top-right — gives each card a
          distinct silhouette without competing with the count. */}
      <Icon
        size={18}
        strokeWidth={1.75}
        className="cat-card-glyph"
        aria-hidden
      />

      {/* Top row: LED status + label. LED color is tone-driven. */}
      <div className="cat-card-head">
        <span className={`led ${ledClassFor(card.tone)}`} aria-hidden />
        <span className="cat-card-label">{card.label}</span>
      </div>

      {/* Readout — recessed framed display panel housing the count.
          Tone-tinted top border so the urgency reads at a glance. */}
      <div className="cat-card-readout">
        <span className="cat-card-count">{card.count}</span>
      </div>

      <span className="cat-card-sub">{card.subtitle}</span>
    </button>
  );
}

function ledClassFor(tone: CategoryTone): string {
  if (tone === 'fault') return 'led-fault';
  if (tone === 'warn') return 'led-warn';
  if (tone === 'ok') return 'led-ok';
  return 'led-idle';
}

// PM schedule row — etched card, status pill via shared .pill tokens,
// primary action via shared .btn classes.
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
              disabled={marking}
              className={`btn btn-secondary ${marking ? 'btn-loading' : ''}`}
              style={{ minHeight: 38, padding: '0 12px', fontSize: 12.5 }}
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
            style={{ minHeight: 38, padding: '0 14px', fontSize: 13 }}
          >
            {marking ? 'Marking…' : 'Mark performed'}
          </button>
        )}
      </div>
    </div>
  );
}

// Plan bucket — one row per (plan, frequency). Tap launches the bucket
// as a click-through job-aid (one step per checklist item). Completing
// the last step auto-logs the bucket as performed via the onCompleted
// callback the parent supplies; "Mark performed" stays as a quick way
// to log without walking the checklist.
function PlanBucketCard({
  planName,
  bucket,
  marking,
  onRun,
  onMarkPerformed,
}: {
  planName: string;
  bucket: PmPlanBucket;
  /** When true the Mark performed button shows a spinner. Driven by
   *  the parent's "currently marking" state so the click has visible
   *  feedback even before the refresh fetch returns. */
  marking: boolean;
  onRun: () => void;
  onMarkPerformed: () => void;
}) {
  const pill = STATUS_PILL[bucket.status];
  const dueText =
    bucket.status === 'overdue'
      ? `Overdue · ${formatDaysUntil(bucket.daysUntilDue)}`
      : bucket.status === 'due'
        ? 'Due today'
        : `Due ${formatDaysUntil(bucket.daysUntilDue)} (${formatNextDue(bucket.nextDueAt)})`;

  return (
    <div className="surface-etched flex flex-col gap-3 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={pill.className}>{pill.label}</span>
            <span className="text-[11px] text-ink-tertiary">{dueText}</span>
          </div>
          {/* Frequency is the heading — Daily / Monthly / Quarterly /
              Yearly. The plan name (e.g., "Cleaning and Inspection
              Schedule") sits above as a small caption since a tech
              looking at three rows of the same plan name learned
              nothing from the repetition. */}
          <div className="mt-1.5 text-[11px] uppercase tracking-[0.1em] text-ink-tertiary">
            {planName}
          </div>
          <div className="mt-0.5 text-[15px] font-medium text-ink-primary">
            {bucket.frequencyLabel}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-ink-tertiary">
            {bucket.itemCount} item{bucket.itemCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRun}
          className="btn btn-primary"
          style={{ minHeight: 38, padding: '0 14px', fontSize: 13 }}
        >
          <Play size={13} strokeWidth={2.25} />
          Start checklist
        </button>
        <button
          type="button"
          onClick={onMarkPerformed}
          disabled={marking}
          className={`btn btn-secondary ${marking ? 'btn-loading' : ''}`}
          style={{ minHeight: 38, padding: '0 12px', fontSize: 12.5 }}
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
            onRun={() => onRunItem(it)}
          />
        ))}
      </ul>
    </div>
  );
}

// Symptom row — tap launches the click-through diagnostic walkthrough
// (the inline causes / remedies are synthesized into job-aid steps by
// the parent before launching).
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

// ─── synth helpers ──────────────────────────────────────────────────
// Build a click-through step list from a plan-bucket's checklist items.
// Each step shows the component + check; the body carries the remarks
// and a hint about any linked procedure (the linked-procedure name is
// surfaced as text rather than a tap target so the inline walkthrough
// stays a single, completable flow).
function planBucketToSteps(bucket: PmPlanBucket): Array<{
  title: string;
  bodyMarkdown?: string | null;
}> {
  return bucket.items.map((it) => {
    const parts: string[] = [];
    if (it.remarks) parts.push(it.remarks);
    if (it.document) parts.push(`_Linked procedure: ${it.document.title}_`);
    return {
      title: `${it.component} — ${it.checkText}`,
      bodyMarkdown: parts.length > 0 ? parts.join('\n\n') : null,
    };
  });
}

// Build a click-through diagnostic walkthrough from a troubleshooting
// row. One step per candidate cause; each step's body lists the remedy
// steps as a markdown list so the tech can work through them in order.
// Legacy unpaired data (causeItems / remedyItems / free-text) is
// flattened into one summary step.
function troubleshootingToSteps(
  item: TroubleshootingGuide['items'][number],
): Array<{ title: string; bodyMarkdown?: string | null }> {
  const out: Array<{ title: string; bodyMarkdown?: string | null }> = [];

  const paired = (item.causes ?? []).filter(
    (c) =>
      c.cause.trim().length > 0 ||
      (c.remedySteps ?? []).some((s) => s.text.trim().length > 0),
  );

  if (paired.length > 0) {
    paired.forEach((c) => {
      const cause = c.cause.trim();
      const steps = (c.remedySteps ?? []).filter(
        (s) => s.text.trim().length > 0,
      );
      const bullets =
        steps.length > 0
          ? steps
              .map((s, i) => {
                const prefix = c.remedyStyle === 'numbered' ? `${i + 1}.` : '-';
                const docHint = s.document
                  ? ` _(see: ${s.document.title})_`
                  : '';
                return `${prefix} ${s.text}${docHint}`;
              })
              .join('\n')
          : '';
      out.push({
        title: cause ? `Possible cause: ${cause}` : 'Possible cause',
        bodyMarkdown: bullets || null,
      });
    });
    return out;
  }

  const causeText =
    item.causeItems.length > 0
      ? item.causeItems
          .filter((c) => c.text.trim())
          .map((c) => `- ${c.text}`)
          .join('\n')
      : item.cause?.trim() ?? '';
  const remedyText =
    item.remedyItems.length > 0
      ? item.remedyItems
          .filter((r) => r.text.trim())
          .map((r, i) => `${i + 1}. ${r.text}`)
          .join('\n')
      : item.remedy?.trim() ?? '';

  if (causeText || remedyText) {
    const sections: string[] = [];
    if (causeText) sections.push(`**Cause(s)**\n\n${causeText}`);
    if (remedyText) sections.push(`**Remedy**\n\n${remedyText}`);
    out.push({
      title: item.symptom,
      bodyMarkdown: sections.join('\n\n'),
    });
  }
  return out;
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
  // Three kinds of history rows: schedule (pmSchedule), plan bucket
  // (pmPlan), and ad-hoc (neither). Render them with a tiny mono-caps
  // kind label so a tech scanning the list can tell which surface the
  // mark came from.
  const kindLabel = record.pmSchedule
    ? 'SCHEDULE'
    : record.pmPlan
      ? 'PM PLAN'
      : 'AD-HOC';
  const title = record.pmSchedule?.name
    ?? (record.pmPlan
      ? `${record.pmPlan.name} · ${record.pmPlan.frequencyLabel}`
      : null);
  return (
    <div className="surface-etched p-3 text-sm">
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
          <div>{record.performedBy?.displayName ?? 'Field tech'}</div>
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
      }}
    >
      <p className="text-base font-medium text-ink-primary">{title}</p>
      <p className="max-w-sm text-sm text-ink-secondary">{body}</p>
    </div>
  );
}
