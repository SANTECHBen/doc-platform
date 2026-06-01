'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  FileText,
  Loader2,
  Rocket,
  XCircle,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
import { ErrorBanner, PrimaryButton, GhostButton } from '@/components/form';
import {
  cancelProcedureDraft,
  executeProcedureDraft,
  getProcedureDraft,
  pickProcedureDraftSections,
  type AdminDraftDetail,
} from '@/lib/api';

// Reviewer for document-import drafts (sourceKind 'docx'|'pdf').
//
// Flow: extracting → pick sections → AI proposes → (auto) materialize the
// procedure → redirect into the real Step Editor. The Step Editor IS the
// review/edit surface — identical to authoring a procedure from scratch — so
// this component is just the front half (upload state, section picker) plus a
// "generating, hold on" bridge that hands off to /procedures/[docId]/edit.
//
// Voiceover is intentionally NOT synthesized here; the author generates it per
// step in the editor (the AI's spoken text lives in the step title + blocks).

export function DocDraftReviewer({ runId }: { runId: string }) {
  const toast = useToast();
  const router = useRouter();
  const [detail, setDetail] = useState<AdminDraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Section-pick state (awaiting_section_pick).
  const [selected, setSelected] = useState<Set<string> | null>(null);

  // Fire-once guards: auto-execute when the proposal is ready, and redirect
  // once the procedure is built.
  const executedRef = useRef(false);
  const redirectedRef = useRef(false);

  // Poll while non-terminal.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function tick() {
      try {
        const d = await getProcedureDraft(runId);
        if (cancelled) return;
        setDetail(d);
        setError(null);
        if (d.run.status === 'failed' || d.run.status === 'cancelled') {
          if (timer) clearInterval(timer);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void tick();
    timer = setInterval(tick, 3_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Default section selection: all top-level (#) headings once the outline lands.
  useEffect(() => {
    if (selected !== null) return;
    const outline = detail?.documentOutline;
    if (!outline || outline.length === 0) return;
    const topLevel = Math.min(...outline.map((o) => o.level));
    setSelected(new Set(outline.filter((o) => o.level === topLevel).map((o) => o.title)));
  }, [detail?.documentOutline, selected]);

  const status = detail?.run.status;

  // Auto-execute as soon as the AI proposal is ready — no intermediate review
  // screen; the Step Editor is the review surface.
  useEffect(() => {
    if (status !== 'awaiting_review' || executedRef.current) return;
    executedRef.current = true;
    void executeProcedureDraft(runId).catch((e) => {
      executedRef.current = false; // allow a retry on next poll
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [status, runId]);

  // Redirect into the editor once the procedure is materialized.
  useEffect(() => {
    if (status !== 'completed' || redirectedRef.current) return;
    const docId = detail?.run.targetDocumentId;
    if (!docId) return;
    redirectedRef.current = true;
    router.push(`/procedures/${docId}/edit`);
  }, [status, detail?.run.targetDocumentId, router]);

  async function generate() {
    if (!selected || selected.size === 0) {
      toast.error('Pick at least one section', 'Select which procedures to generate.');
      return;
    }
    setBusy(true);
    try {
      await pickProcedureDraftSections(runId, [...selected]);
      toast.success('Generating', 'The AI is drafting your procedure…');
      const d = await getProcedureDraft(runId);
      setDetail(d);
    } catch (e) {
      toast.error('Failed to start', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function abandon() {
    setBusy(true);
    try {
      await cancelProcedureDraft(runId);
      const d = await getProcedureDraft(runId);
      setDetail(d);
    } catch (e) {
      toast.error('Cancel failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const generating =
    status === 'proposing' || status === 'awaiting_review' || status === 'executing';

  return (
    <PageShell
      crumbs={[
        { label: 'AI drafts', href: '/procedure-drafts' },
        { label: detail?.run.proposedTitle ?? 'Draft' },
      ]}
    >
      <div className="mb-3">
        <Link
          href="/procedure-drafts"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-tertiary hover:text-ink-primary"
        >
          <ArrowLeft size={12} /> Back to drafts
        </Link>
      </div>
      <PageHeader
        title={detail?.run.proposedTitle ?? 'Document draft'}
        description={
          <span className="inline-flex items-center gap-2 text-xs">
            <FileText size={14} />
            {detail?.run.sourceKind === 'pdf' ? 'PDF' : 'Word'} import
            {detail?.documentOutline
              ? ` · ${detail.documentOutline.length} section(s) found`
              : ''}
          </span>
        }
      />
      <ErrorBanner error={error ?? detail?.run.error ?? null} />

      {/* ---- Extracting ---- */}
      {status === 'extracting' && (
        <StatusCard icon={<Loader2 className="size-5 animate-spin" />}>
          Parsing the document and extracting figures…
        </StatusCard>
      )}

      {/* ---- Section picker ---- */}
      {status === 'awaiting_section_pick' && (
        <div className="flex max-w-2xl flex-col gap-3">
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink-primary">
              Which procedures should we generate?
            </h2>
            <p className="text-xs text-ink-secondary">
              We found these sections in the document. Pick the ones to turn into a structured
              procedure. Figures are extracted only from the sections you select. The AI keeps your
              steps and callouts — you&rsquo;ll review and refine everything in the Step Editor.
            </p>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() =>
                  setSelected(new Set((detail?.documentOutline ?? []).map((o) => o.title)))
                }
              >
                Select all
              </button>
              <span className="text-ink-tertiary">·</span>
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            </div>
            <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line bg-surface">
              {(detail?.documentOutline ?? []).map((o, i) => {
                const on = selected?.has(o.title) ?? false;
                return (
                  <li key={`${o.title}-${i}`}>
                    <label
                      className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-raised"
                      style={{ paddingLeft: `${12 + (o.level - 1) * 16}px` }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev ?? []);
                            if (next.has(o.title)) next.delete(o.title);
                            else next.add(o.title);
                            return next;
                          });
                        }}
                      />
                      <span className={o.level === 1 ? 'font-medium text-ink-primary' : 'text-ink-secondary'}>
                        {o.title}
                      </span>
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-tertiary">
                        H{o.level}
                      </span>
                    </label>
                  </li>
                );
              })}
              {(detail?.documentOutline ?? []).length === 0 && (
                <li className="px-3 py-3 text-xs text-ink-tertiary">
                  No headings detected — the whole document will be used.
                </li>
              )}
            </ul>
            <div className="flex justify-end">
              <PrimaryButton onClick={() => void generate()} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Rocket size={14} />}
                Generate {selected?.size ? `${selected.size} ` : ''}procedure(s)
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}

      {/* ---- Generating → handing off to the editor ---- */}
      {generating && (
        <StatusCard icon={<Loader2 className="size-5 animate-spin" />}>
          <div className="flex flex-col gap-1">
            <span>Building your procedure — sections, steps, and figures…</span>
            <span className="text-xs text-ink-tertiary">
              You&rsquo;ll be dropped into the Step Editor automatically when it&rsquo;s ready.
            </span>
          </div>
        </StatusCard>
      )}

      {/* ---- Completed → redirecting ---- */}
      {status === 'completed' && (
        <StatusCard icon={<Loader2 className="size-5 animate-spin" />}>
          <div className="flex flex-col items-start gap-2">
            <span>Procedure ready. Opening the Step Editor…</span>
            {detail?.run.targetDocumentId && (
              <Link
                href={`/procedures/${detail.run.targetDocumentId}/edit`}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-accent hover:border-accent/40"
              >
                Open the Step Editor
              </Link>
            )}
          </div>
        </StatusCard>
      )}

      {/* ---- Failed / cancelled ---- */}
      {(status === 'failed' || status === 'cancelled') && (
        <StatusCard icon={<XCircle className="size-5 text-signal-fault" />}>
          <div className="flex flex-col items-start gap-2">
            <span>{status === 'cancelled' ? 'Draft cancelled.' : detail?.run.error ?? 'Draft failed.'}</span>
            <Link
              href="/procedure-drafts/new"
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:text-ink-primary"
            >
              Start over
            </Link>
          </div>
        </StatusCard>
      )}

      {/* Cancel affordance during the long-running phases. */}
      {(status === 'extracting' || generating) && (
        <div className="mt-3">
          <GhostButton onClick={() => void abandon()} disabled={busy}>
            Cancel draft
          </GhostButton>
        </div>
      )}

      {/* Surface AI warnings on the section-pick screen if any rode along. */}
      {status === 'awaiting_section_pick' &&
        detail?.proposal &&
        'warnings' in (detail.proposal.content as { warnings?: string[] }) &&
        ((detail.proposal.content as { warnings?: string[] }).warnings?.length ?? 0) > 0 && (
          <div className="mt-3 rounded-md border border-signal-warn/40 bg-signal-warn/5 px-3 py-2">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-signal-warn">
              <AlertTriangle size={13} /> Notes from a prior run
            </p>
          </div>
        )}
    </PageShell>
  );
}

function StatusCard({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-surface px-4 py-6 text-sm text-ink-secondary">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

