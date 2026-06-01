'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Clapperboard, Film, Loader2, Plus } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { PageHeader, PageShell } from '@/components/page-shell';
import { ErrorBanner, PrimaryButton } from '@/components/form';
import {
  listProcedureDrafts,
  type AdminDraftRun,
  type ProcedureDraftRunStatus,
} from '@/lib/api';
import { DateLabel } from '@/components/date-label';

const STATUS_LABEL: Record<ProcedureDraftRunStatus, string> = {
  uploading: 'Uploading',
  transcribing: 'Transcribing',
  storyboarding: 'Storyboarding',
  extracting: 'Extracting',
  awaiting_section_pick: 'Pick sections',
  pending_admin_decision: 'Pending review',
  proposing: 'Proposing steps',
  awaiting_review: 'Ready for review',
  executing: 'Executing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<ProcedureDraftRunStatus, string> = {
  uploading: 'bg-surface-elevated text-ink-secondary',
  transcribing: 'bg-accent/10 text-accent',
  storyboarding: 'bg-accent/10 text-accent',
  extracting: 'bg-accent/10 text-accent',
  awaiting_section_pick: 'bg-signal-warn/15 text-signal-warn',
  pending_admin_decision: 'bg-signal-warn/15 text-signal-warn',
  proposing: 'bg-accent/10 text-accent',
  awaiting_review: 'bg-signal-info/15 text-signal-info',
  executing: 'bg-accent/10 text-accent',
  completed: 'bg-signal-ok/15 text-signal-ok',
  failed: 'bg-signal-fault/15 text-signal-fault',
  cancelled: 'bg-surface-elevated text-ink-tertiary',
};

export default function ProcedureDraftsPage() {
  const [rows, setRows] = useState<AdminDraftRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function tick() {
      try {
        const r = await listProcedureDrafts();
        if (!cancelled) {
          setRows(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    void tick();
    // Polled refresh — drafts move through several async stages so the
    // list page benefits from a heartbeat. 5s strikes a balance between
    // freshness and idle traffic. SSE on the detail page handles the
    // heavy stream.
    timer = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <PageShell crumbs={[{ label: 'Procedure drafts' }]}>
      <PageHeader
        title="AI procedure drafts"
        description="Upload a recorded walkthrough or an existing Word/PDF procedure; the AI proposes a structured procedure (steps, callouts, figures, voiceover). Review, edit, and accept to materialize it as a real procedure."
        actions={
          <Link
            href="/procedure-drafts/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90"
          >
            <Plus size={14} strokeWidth={2.25} /> New draft
          </Link>
        }
      />
      <ErrorBanner error={error} />
      {rows === null ? (
        <TableSkeleton cols={4} rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="No AI drafts yet"
          description="Record a walkthrough on site (any phone or camera works), or upload an existing Word/PDF procedure. The AI turns it into structured steps with figures and voiceover for your review."
          action={
            <Link
              href="/procedure-drafts/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent/90"
            >
              <Plus size={14} strokeWidth={2.25} /> Start a new draft
            </Link>
          }
        />
      ) : (
        <ul className="overflow-hidden rounded-md border border-line bg-surface-raised">
          {rows.map((r) => (
            <li
              key={r.id}
              className="border-b border-line-subtle last:border-b-0"
            >
              <Link
                href={`/procedure-drafts/${r.id}`}
                className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-elevated"
              >
                <Film className="size-4 shrink-0 text-ink-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-medium text-ink-primary">
                    {r.proposedTitle}
                    {r.pwaSubmitted && (
                      <span className="inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
                        PWA
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-tertiary">
                    Created <DateLabel iso={r.createdAt} />
                    {r.sourceVideoDurationMs
                      ? ` · ${Math.round(r.sourceVideoDurationMs / 60_000)} min`
                      : ''}
                    {r.transcriptSource ? ` · transcript: ${r.transcriptSource}` : ''}
                  </p>
                </div>
                <span
                  className={[
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                    STATUS_TONE[r.status],
                  ].join(' ')}
                >
                  {r.status === 'proposing' || r.status === 'transcribing' || r.status === 'executing' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  {STATUS_LABEL[r.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
