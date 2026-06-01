'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Loader2,
  Rocket,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
import {
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
  GhostButton,
  TextInput,
  Textarea,
} from '@/components/form';
import {
  cancelProcedureDraft,
  executeProcedureDraft,
  getProcedureDraft,
  patchProcedureDraftProposal,
  pickProcedureDraftSections,
  type AdminDraftDetail,
  type AdminDraftDocProposalTree,
  type AdminDraftDocStepProposal,
  type AdminDraftFigureThumb,
} from '@/lib/api';

// Reviewer for document-import drafts (sourceKind 'docx'|'pdf'). Drives the
// full lifecycle: extracting → pick sections → propose → review/edit →
// execute → done. Self-contained (own polling + state) so the Mux-based
// video reviewer never has to know about documents.

function isDocTree(t: unknown): t is AdminDraftDocProposalTree {
  return !!t && typeof t === 'object' && (t as { source?: string }).source === 'document';
}

export function DocDraftReviewer({ runId }: { runId: string }) {
  const toast = useToast();
  const [detail, setDetail] = useState<AdminDraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Section-pick state (awaiting_section_pick).
  const [selected, setSelected] = useState<Set<string> | null>(null);

  // Edited steps (awaiting_review).
  const [steps, setSteps] = useState<AdminDraftDocStepProposal[] | null>(null);
  const [log, setLog] = useState<Array<{ phase: string; clientId?: string; error?: string }>>([]);

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
        // Seed edited steps once the proposal lands.
        if (d.proposal && isDocTree(d.proposal.content) && steps === null) {
          setSteps(d.proposal.content.steps);
        }
        if (
          d.run.status === 'completed' ||
          d.run.status === 'failed' ||
          d.run.status === 'cancelled'
        ) {
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
    if (!outline) return;
    const topLevel = Math.min(...outline.map((o) => o.level));
    setSelected(new Set(outline.filter((o) => o.level === topLevel).map((o) => o.title)));
  }, [detail?.documentOutline, selected]);

  const status = detail?.run.status;
  const figures = detail?.figures ?? [];
  const figuresById = useMemo(
    () => new Map(figures.map((f) => [f.figureId, f] as const)),
    [figures],
  );

  const proposalContent =
    detail?.proposal && isDocTree(detail.proposal.content) ? detail.proposal.content : null;
  const dirty = useMemo(() => {
    if (!proposalContent || !steps) return false;
    return JSON.stringify(proposalContent.steps) !== JSON.stringify(steps);
  }, [proposalContent, steps]);

  async function generate() {
    if (!selected || selected.size === 0) {
      toast.error('Pick at least one section', 'Select which procedures to generate.');
      return;
    }
    setBusy(true);
    try {
      await pickProcedureDraftSections(runId, [...selected]);
      toast.success('Generating', 'The AI is drafting steps from the selected sections…');
      const d = await getProcedureDraft(runId);
      setDetail(d);
    } catch (e) {
      toast.error('Failed to start', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdits(): Promise<boolean> {
    if (!detail?.proposal || !proposalContent || !steps) return false;
    setBusy(true);
    try {
      const next: AdminDraftDocProposalTree = { ...proposalContent, steps };
      const updated = await patchProcedureDraftProposal(runId, {
        version: detail.proposal.version,
        content: next,
      });
      setDetail({ ...detail, proposal: updated });
      if (isDocTree(updated.content)) setSteps(updated.content.steps);
      toast.success('Saved', `Proposal v${updated.version}`);
      return true;
    } catch (e) {
      toast.error('Save failed', e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!detail?.proposal) return;
    if (dirty) {
      const ok = await saveEdits();
      if (!ok) return;
    }
    setBusy(true);
    setLog([]);
    try {
      await executeProcedureDraft(runId);
      toast.success('Building procedure', 'Creating sections, steps, figures, and voiceover…');
      const d = await getProcedureDraft(runId);
      setDetail(d);
    } catch (e) {
      toast.error('Execute failed', e instanceof Error ? e.message : String(e));
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

  function updateStep(i: number, patch: Partial<AdminDraftDocStepProposal>) {
    setSteps((prev) => (prev ? prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) : prev));
  }
  function removeStep(i: number) {
    setSteps((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function toggleFigure(i: number, figureId: string) {
    setSteps((prev) =>
      prev
        ? prev.map((s, idx) => {
            if (idx !== i) return s;
            const has = s.figureRefs.includes(figureId);
            return {
              ...s,
              figureRefs: has
                ? s.figureRefs.filter((f) => f !== figureId)
                : [...s.figureRefs, figureId],
            };
          })
        : prev,
    );
  }

  const crumbs = [
    { label: 'AI drafts', href: '/procedure-drafts' },
    { label: detail?.run.proposedTitle ?? 'Draft' },
  ];

  return (
    <PageShell crumbs={crumbs}>
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
            {detail?.run.sourceKind === 'pdf' ? 'PDF' : 'Word'} import ·{' '}
            {detail?.run.figureCount ?? 0} figure(s) extracted
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
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-ink-primary">
              Which procedures should we generate?
            </h2>
            <p className="text-xs text-ink-secondary">
              We found these sections in the document. Pick the ones to turn into structured
              procedures. The AI keeps your steps, callouts, and figures.
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
          <FigureGallery figures={figures} />
        </div>
      )}

      {/* ---- Proposing ---- */}
      {status === 'proposing' && (
        <StatusCard icon={<Loader2 className="size-5 animate-spin" />}>
          The AI is drafting steps from your document…
        </StatusCard>
      )}

      {/* ---- Review / edit ---- */}
      {status === 'awaiting_review' && proposalContent && steps && (
        <div className="flex flex-col gap-4">
          {proposalContent.summary && (
            <p className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-secondary">
              {proposalContent.summary}
            </p>
          )}
          {proposalContent.warnings.length > 0 && (
            <div className="rounded-md border border-signal-warn/40 bg-signal-warn/5 px-3 py-2">
              <p className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-signal-warn">
                <AlertTriangle size={13} /> Review notes
              </p>
              <ul className="ml-4 list-disc space-y-0.5 text-[11px] text-ink-secondary">
                {proposalContent.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {steps.map((s, i) => (
              <DocStepCard
                key={s.clientId}
                index={i}
                step={s}
                figures={figures}
                figuresById={figuresById}
                onChange={(patch) => updateStep(i, patch)}
                onRemove={() => removeStep(i)}
                onToggleFigure={(fid) => toggleFigure(i, fid)}
              />
            ))}
          </div>

          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-line bg-surface/95 py-3 backdrop-blur">
            <span className="text-xs text-ink-tertiary">
              {steps.length} step(s){dirty ? ' · unsaved edits' : ''}
            </span>
            <div className="flex gap-2">
              <GhostButton onClick={() => void abandon()} disabled={busy}>
                Cancel draft
              </GhostButton>
              <SecondaryButton onClick={() => void saveEdits()} disabled={busy || !dirty}>
                Save edits
              </SecondaryButton>
              <PrimaryButton onClick={() => void accept()} disabled={busy || steps.length === 0}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 size={14} />}
                Accept & build procedure
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}

      {/* ---- Executing ---- */}
      {status === 'executing' && (
        <StatusCard icon={<Loader2 className="size-5 animate-spin" />}>
          Building the procedure — creating sections, steps, attaching figures, and synthesizing
          voiceover…
          {log.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-auto text-left font-mono text-[10px] text-ink-tertiary">
              {log.map((l, i) => (
                <li key={i}>
                  {l.phase} {l.clientId ?? ''} {l.error ?? ''}
                </li>
              ))}
            </ul>
          )}
        </StatusCard>
      )}

      {/* ---- Done ---- */}
      {status === 'completed' && (
        <StatusCard icon={<CheckCircle2 className="size-5 text-signal-ok" />}>
          <div className="flex flex-col items-start gap-2">
            <span>Procedure created.</span>
            {detail?.run.targetDocumentId && (
              <Link
                href={`/procedures/${detail.run.targetDocumentId}/edit`}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-accent hover:border-accent/40"
              >
                Open in the step editor
              </Link>
            )}
          </div>
        </StatusCard>
      )}

      {/* ---- Failed / cancelled ---- */}
      {(status === 'failed' || status === 'cancelled') && (
        <StatusCard icon={<XCircle className="size-5 text-signal-fault" />}>
          {status === 'cancelled' ? 'Draft cancelled.' : detail?.run.error ?? 'Draft failed.'}
        </StatusCard>
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

function FigureGallery({ figures }: { figures: AdminDraftFigureThumb[] }) {
  return (
    <aside className="flex flex-col gap-2">
      <p className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
        <ImageIcon size={12} /> Extracted figures ({figures.length})
      </p>
      {figures.length === 0 ? (
        <p className="text-[11px] text-ink-tertiary">
          No figures were extracted. You can attach images per step later in the editor.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {figures.map((f) => (
            <figure key={f.figureId} className="overflow-hidden rounded-md border border-line bg-surface">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.url} alt={f.caption ?? f.figureId} className="aspect-square w-full object-cover" />
              <figcaption className="truncate px-1.5 py-1 text-[9px] text-ink-tertiary" title={f.caption ?? f.figureId}>
                {f.figureId}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </aside>
  );
}

function DocStepCard({
  index,
  step,
  figures,
  figuresById,
  onChange,
  onRemove,
  onToggleFigure,
}: {
  index: number;
  step: AdminDraftDocStepProposal;
  figures: AdminDraftFigureThumb[];
  figuresById: Map<string, AdminDraftFigureThumb>;
  onChange: (patch: Partial<AdminDraftDocStepProposal>) => void;
  onRemove: () => void;
  onToggleFigure: (figureId: string) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line-subtle px-3 py-1.5">
        <span className="font-mono text-[10px] text-ink-tertiary">#{index + 1}</span>
        {step.sectionTitle && (
          <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-ink-secondary">
            {step.sectionTitle}
          </span>
        )}
        <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-tertiary">
          {step.kind.replace(/_/g, ' ')}
        </span>
        {step.safetyCritical && (
          <span className="inline-flex items-center gap-1 rounded bg-signal-fault/10 px-1.5 py-0.5 text-[10px] text-signal-fault">
            <ShieldAlert size={10} /> safety
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-ink-tertiary">
          {Math.round(step.confidence * 100)}%
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
          aria-label="Remove step"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">Title</span>
          <TextInput value={step.title} onChange={(e) => onChange({ title: e.target.value })} maxLength={200} />
        </label>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">Section</span>
            <TextInput
              value={step.sectionTitle ?? ''}
              onChange={(e) => onChange({ sectionTitle: e.target.value || undefined })}
              placeholder="e.g. Removal"
              maxLength={200}
            />
          </label>
          <label className="flex items-end gap-2 pb-1.5 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={step.safetyCritical}
              onChange={(e) => onChange({ safetyCritical: e.target.checked })}
            />
            Safety-critical
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
            Voiceover (spoken)
          </span>
          <Textarea
            value={step.voiceoverText}
            onChange={(e) => onChange({ voiceoverText: e.target.value })}
            rows={2}
            maxLength={2000}
          />
        </label>

        {/* Figures */}
        {figures.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
              Figures on this step
            </span>
            <div className="flex flex-wrap gap-2">
              {figures.map((f) => {
                const on = step.figureRefs.includes(f.figureId);
                return (
                  <button
                    key={f.figureId}
                    type="button"
                    onClick={() => onToggleFigure(f.figureId)}
                    title={f.caption ?? f.figureId}
                    className={[
                      'relative h-12 w-12 overflow-hidden rounded border-2 transition',
                      on ? 'border-accent' : 'border-line opacity-50 hover:opacity-100',
                    ].join(' ')}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.url} alt={f.figureId} className="h-full w-full object-cover" />
                    {on && (
                      <span className="absolute inset-x-0 bottom-0 bg-accent/80 text-center text-[8px] text-white">
                        on
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Blocks (read-only preview) */}
        {step.blocks.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {step.blocks.length} content block(s)
            </summary>
            <ul className="mt-1 flex flex-col gap-1">
              {step.blocks.map((b, bi) => (
                <li key={bi} className="rounded bg-surface-raised px-2 py-1 text-[11px] text-ink-secondary">
                  <span className="mr-1 text-[9px] uppercase text-ink-tertiary">{String(b.kind)}</span>
                  {blockPreview(b as unknown as { kind: string } & Record<string, unknown>)}
                </li>
              ))}
            </ul>
          </details>
        )}
        {step.figureRefs.some((id) => !figuresById.has(id)) && (
          <p className="text-[10px] text-signal-warn">Some referenced figures are no longer available.</p>
        )}
      </div>
    </div>
  );
}

function blockPreview(b: { kind: string } & Record<string, unknown>): string {
  if (b.kind === 'paragraph') return String(b.text ?? '');
  if (b.kind === 'callout') return `${b.tone ?? ''}: ${String(b.text ?? '')}`;
  if (b.kind === 'bullet_list' || b.kind === 'numbered_list') {
    const items = Array.isArray(b.items) ? (b.items as string[]) : [];
    return items.join(' · ');
  }
  if (b.kind === 'key_value') {
    const rows = Array.isArray(b.rows) ? (b.rows as string[][]) : [];
    return rows.map((r) => r.join(': ')).join(' · ');
  }
  return '';
}
