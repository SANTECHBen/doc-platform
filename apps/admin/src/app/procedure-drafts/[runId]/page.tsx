'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clapperboard,
  Film,
  Loader2,
  Play,
  Rocket,
  XCircle,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
import {
  ErrorBanner,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  TextInput,
  Textarea,
} from '@/components/form';
import {
  cancelProcedureDraft,
  executeProcedureDraft,
  getProcedureDraft,
  patchProcedureDraftProposal,
  refreshProcedureDraftFromMux,
  runAiOnProcedureDraft,
  type AdminDraftDetail,
  type AdminDraftProposalTree,
  type AdminDraftStepProposal,
} from '@/lib/api';

type Phase =
  | 'loading'
  | 'awaiting_video'
  | 'transcribing'
  | 'pending_decision'
  | 'proposing'
  | 'ready'
  | 'executing'
  | 'done'
  | 'failed';

export default function DraftReviewerPage() {
  const params = useParams<{ runId: string }>();
  const toast = useToast();
  const runId = params.runId;

  const [detail, setDetail] = useState<AdminDraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSteps, setDraftSteps] = useState<AdminDraftStepProposal[]>([]);
  const [executing, setExecuting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [executionLog, setExecutionLog] = useState<
    Array<{ phase: string; clientId?: string; error?: string; at: number }>
  >([]);

  // Poll while the run is in a non-terminal status. Replace with full SSE
  // later if the latency stings — 3s is fine for v1.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function tick() {
      try {
        const d = await getProcedureDraft(runId);
        if (!cancelled) {
          setDetail(d);
          if (d.proposal && draftSteps.length === 0) {
            setDraftSteps(d.proposal.content.steps);
          }
          setError(null);
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

  const phase: Phase = useMemo(() => {
    if (!detail) return 'loading';
    const status = detail.run.status;
    if (status === 'uploading') return 'awaiting_video';
    if (status === 'transcribing' || status === 'storyboarding') return 'transcribing';
    if (status === 'pending_admin_decision') return 'pending_decision';
    if (status === 'proposing') return 'proposing';
    if (status === 'awaiting_review') return 'ready';
    if (status === 'executing') return 'executing';
    if (status === 'completed') return 'done';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    return 'loading';
  }, [detail]);

  const dirty = useMemo(() => {
    if (!detail?.proposal) return false;
    return JSON.stringify(detail.proposal.content.steps) !== JSON.stringify(draftSteps);
  }, [detail?.proposal, draftSteps]);

  async function saveEdits() {
    if (!detail?.proposal) return;
    setBusy(true);
    try {
      const next: AdminDraftProposalTree = {
        ...detail.proposal.content,
        steps: draftSteps,
      };
      const updated = await patchProcedureDraftProposal(runId, {
        version: detail.proposal.version,
        content: next,
      });
      setDetail({ ...detail, proposal: updated });
      setDraftSteps(updated.content.steps);
      toast.success('Saved', `Proposal v${updated.version}`);
    } catch (e) {
      toast.error('Save failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startExecute() {
    if (!detail?.proposal) return;
    if (dirty) {
      // Persist edits before executing — otherwise the executor consumes
      // the prior server state.
      await saveEdits();
    }
    setBusy(true);
    setExecuting(true);
    try {
      const res = await executeProcedureDraft(runId);
      toast.success('Started', 'AI is materializing the procedure now.');
      // Open SSE for progress when a stream token is available. Falls
      // back to the polling above when stream tokens aren't configured.
      if (res.streamToken) {
        const url = `${process.env.NEXT_PUBLIC_API_BASE ?? ''}/admin/procedure-drafts/${runId}/events?token=${encodeURIComponent(res.streamToken)}&purpose=execute`;
        const es = new EventSource(url, { withCredentials: false });
        const onMessage = (evt: MessageEvent<string>) => {
          try {
            const data = JSON.parse(evt.data);
            setExecutionLog((prev) => [
              ...prev,
              { phase: evt.type, clientId: data.clientId, error: data.error, at: Date.now() },
            ]);
            if (evt.type === 'completed' || evt.type === 'failed') {
              es.close();
            }
          } catch {
            // ignore malformed events
          }
        };
        // EventSource fires "message" for unnamed events; named events
        // fire on their named handler. Subscribe to all the names we use.
        for (const name of ['executing', 'starting', 'keyframe', 'tts', 'inserting', 'done', 'failed', 'completed', 'cancelled']) {
          es.addEventListener(name, onMessage as EventListener);
        }
      }
    } catch (e) {
      toast.error('Execute failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await cancelProcedureDraft(runId);
      toast.success('Cancelled', 'Run marked cancelled.');
    } catch (e) {
      toast.error('Cancel failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runAi() {
    setBusy(true);
    try {
      await runAiOnProcedureDraft(runId);
      toast.success('AI started', 'Claude is segmenting the transcript now.');
    } catch (e) {
      toast.error('Run AI failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshFromMux() {
    setBusy(true);
    try {
      const r = await refreshProcedureDraftFromMux(runId);
      const summary =
        r.changed.length > 0 ? r.changed.join(', ') : 'no changes from Mux yet';
      toast.success('Refreshed', summary);
    } catch (e) {
      toast.error(
        'Refresh failed',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  function updateStep(clientId: string, patch: Partial<AdminDraftStepProposal>) {
    setDraftSteps((prev) =>
      prev.map((s) => (s.clientId === clientId ? { ...s, ...patch } : s)),
    );
  }

  function removeStep(clientId: string) {
    setDraftSteps((prev) => prev.filter((s) => s.clientId !== clientId));
  }

  function moveStep(clientId: string, delta: -1 | 1) {
    setDraftSteps((prev) => {
      const idx = prev.findIndex((s) => s.clientId === clientId);
      if (idx < 0) return prev;
      const next = idx + delta;
      if (next < 0 || next >= prev.length) return prev;
      const out = prev.slice();
      const item = out[idx]!;
      const swap = out[next]!;
      out[idx] = swap;
      out[next] = item;
      return out;
    });
  }

  return (
    <PageShell
      crumbs={[
        { label: 'Procedure drafts', href: '/procedure-drafts' },
        { label: detail?.run.proposedTitle ?? 'Loading…' },
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
        title={detail?.run.proposedTitle ?? 'Loading…'}
        description={
          <span className="inline-flex items-center gap-2 text-xs">
            <Clapperboard size={14} /> AI procedure drafter
            {detail?.run.transcriptSource ? ` · transcript: ${detail.run.transcriptSource}` : ''}
            {detail?.proposal?.tokenUsage
              ? ` · tokens: ${detail.proposal.tokenUsage.inputTokens}/${detail.proposal.tokenUsage.outputTokens}`
              : ''}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {phase === 'pending_decision' && (
              <>
                <GhostButton onClick={() => void cancel()} disabled={busy}>
                  Dismiss
                </GhostButton>
                <PrimaryButton onClick={() => void runAi()} disabled={busy}>
                  <Rocket size={14} /> Run AI on this
                </PrimaryButton>
              </>
            )}
            {phase === 'ready' && (
              <>
                {dirty && (
                  <SecondaryButton onClick={() => void saveEdits()} disabled={busy}>
                    Save edits
                  </SecondaryButton>
                )}
                <PrimaryButton onClick={() => void startExecute()} disabled={busy || dirty}>
                  <Rocket size={14} /> Accept and create procedure
                </PrimaryButton>
              </>
            )}
            {(phase === 'awaiting_video' ||
              phase === 'transcribing' ||
              phase === 'failed') && (
              <SecondaryButton onClick={() => void refreshFromMux()} disabled={busy}>
                Refresh from Mux
              </SecondaryButton>
            )}
            {(phase === 'transcribing' || phase === 'proposing' || phase === 'awaiting_video') && (
              <GhostButton onClick={() => void cancel()} disabled={busy}>
                Cancel
              </GhostButton>
            )}
          </div>
        }
      />
      <ErrorBanner error={error ?? detail?.run.error ?? null} />

      {/* PWA-submission context strip — shows the admin who filmed it
          and which asset they were working on, so the decision to run
          AI has the right context. */}
      {detail?.run.pwaSubmitted && (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-ink-primary">
          <Clapperboard size={14} className="mt-0.5 text-accent" />
          <div className="flex-1">
            <p className="font-semibold">
              Submitted from the PWA
              {detail.run.submittedFromAssetInstanceId && (
                <span
                  className="ml-1 font-normal text-ink-tertiary"
                  title={detail.run.submittedFromAssetInstanceId}
                >
                  · asset {detail.run.submittedFromAssetInstanceId.slice(0, 8)}
                </span>
              )}
            </p>
            {detail.run.submissionNotes && (
              <p className="mt-1 text-ink-secondary">
                &ldquo;{detail.run.submissionNotes}&rdquo;
              </p>
            )}
          </div>
        </div>
      )}

      {phase === 'loading' && <p className="text-sm text-ink-tertiary">Loading…</p>}

      {phase === 'awaiting_video' && (
        <AwaitingVideo runId={runId} />
      )}

      {phase === 'pending_decision' && detail && (
        <PendingDecisionPanel detail={detail} runId={runId} />
      )}

      {(phase === 'transcribing' || phase === 'proposing') && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">
          <Loader2 className="size-4 animate-spin" />
          {phase === 'transcribing'
            ? 'Transcribing the video…'
            : 'Drafting steps from the transcript…'}
        </div>
      )}

      {phase === 'failed' && detail?.run.error && (
        <div className="rounded-md border border-signal-fault/40 bg-signal-fault/5 px-4 py-3 text-sm text-signal-fault">
          {detail.run.error}
        </div>
      )}

      {(phase === 'ready' || phase === 'executing' || phase === 'done') && detail?.proposal && (
        <div className="grid gap-6 lg:grid-cols-[1fr_460px]">
          <main className="flex flex-col gap-3">
            {detail.playbackId && (
              <video
                controls
                preload="metadata"
                className="w-full rounded-md border border-line bg-black"
                src={`https://stream.mux.com/${detail.playbackId}/low.mp4`}
              />
            )}
            {detail.transcript && (
              <details className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-secondary">
                <summary className="cursor-pointer text-ink-primary">
                  Transcript ({detail.transcript.length} chars)
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
                  {detail.transcript}
                </pre>
              </details>
            )}
            {executionLog.length > 0 && (
              <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs">
                <p className="font-semibold text-ink-primary">Execution progress</p>
                <ul className="mt-1 max-h-40 overflow-y-auto text-[11px] text-ink-secondary">
                  {executionLog.map((e, i) => (
                    <li key={i}>
                      [{new Date(e.at).toLocaleTimeString()}] {e.phase}
                      {e.clientId ? ` · ${e.clientId}` : ''}
                      {e.error ? ` · ${e.error}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </main>
          <aside className="flex flex-col gap-2">
            {detail.proposal.content.warnings.length > 0 && (
              <div className="rounded-md border border-signal-warn/30 bg-signal-warn/5 px-3 py-2 text-[11px] text-signal-warn">
                <p className="font-semibold uppercase tracking-wider">Warnings</p>
                <ul className="mt-1 list-inside list-disc">
                  {detail.proposal.content.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <ol className="flex flex-col gap-2">
              {draftSteps.map((step, i) => (
                <li key={step.clientId}>
                  <DraftStepCard
                    step={step}
                    index={i}
                    canMoveUp={i > 0}
                    canMoveDown={i < draftSteps.length - 1}
                    locked={phase !== 'ready'}
                    onChange={(patch) => updateStep(step.clientId, patch)}
                    onRemove={() => removeStep(step.clientId)}
                    onMoveUp={() => moveStep(step.clientId, -1)}
                    onMoveDown={() => moveStep(step.clientId, 1)}
                  />
                </li>
              ))}
            </ol>
          </aside>
        </div>
      )}
    </PageShell>
  );
}

// Shown while a PWA-submitted draft sits gated waiting for an admin to
// decide whether to spend on the LLM. The transcript + video are
// already available — admin can read the transcript, watch the clip,
// and use the page-header "Run AI on this" or "Dismiss" buttons.
function PendingDecisionPanel({
  detail,
  runId,
}: {
  detail: AdminDraftDetail;
  runId: string;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <main className="flex flex-col gap-3">
        {detail.playbackId && (
          <video
            controls
            preload="metadata"
            className="w-full rounded-md border border-line bg-black"
            src={`https://stream.mux.com/${detail.playbackId}/low.mp4`}
          />
        )}
        {detail.transcript ? (
          <details className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-secondary" open>
            <summary className="cursor-pointer text-ink-primary">
              Transcript ({detail.transcript.length} chars)
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
              {detail.transcript}
            </pre>
          </details>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">
            <Loader2 className="size-4 animate-spin" /> Transcript still
            processing — Mux usually takes 1-2 minutes after the upload
            finishes. Refresh shortly.
          </div>
        )}
      </main>
      <aside className="flex flex-col gap-3">
        <div className="rounded-md border border-line bg-surface-raised px-3 py-3 text-xs">
          <p className="font-semibold text-ink-primary">Ready for your decision</p>
          <p className="mt-1 text-ink-secondary">
            A tech submitted this walkthrough from the PWA. Watch the clip
            and skim the transcript, then:
          </p>
          <ul className="mt-2 ml-4 list-disc space-y-1 text-ink-secondary">
            <li>
              <strong>Run AI on this</strong> — spend a Claude Opus 4.7
              call (~$0.25–$1) to draft steps with timestamped keyframes.
              You&rsquo;ll edit and accept in the reviewer.
            </li>
            <li>
              <strong>Dismiss</strong> — closes this submission without
              spending on the LLM. The video stays in Mux for reference.
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function AwaitingVideo({ runId }: { runId: string }) {
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-6 text-sm text-ink-secondary">
      <p className="font-medium text-ink-primary">Waiting for video upload…</p>
      <p className="mt-1 text-xs">
        If the upload finished on the tech&rsquo;s device but the status
        hasn&rsquo;t moved here, tap <strong>Refresh from Mux</strong> in
        the header — we&rsquo;ll poll Mux directly and advance the run.
        Webhooks can sometimes miss; the refresh button is the manual
        recovery path. Run id: <code>{runId}</code>.
      </p>
      <p className="mt-2 text-xs">
        Need to start a brand-new admin-uploaded draft instead?{' '}
        <Link
          href="/procedure-drafts/new"
          className="font-semibold text-accent hover:underline"
        >
          New draft
        </Link>
        .
      </p>
    </div>
  );
}

function DraftStepCard({
  step,
  index,
  canMoveUp,
  canMoveDown,
  locked,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  step: AdminDraftStepProposal;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  locked: boolean;
  onChange: (patch: Partial<AdminDraftStepProposal>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const confidence =
    step.confidence < 0.4 ? 'low' : step.confidence < 0.7 ? 'med' : 'high';
  const confColor =
    confidence === 'low'
      ? 'bg-signal-warn/15 text-signal-warn'
      : confidence === 'med'
        ? 'bg-surface-elevated text-ink-secondary'
        : 'bg-signal-ok/15 text-signal-ok';
  return (
    <div className="rounded-md border border-line bg-surface-raised p-2">
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="font-mono text-[10px] text-ink-tertiary">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span
          className={[
            'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
            confColor,
          ].join(' ')}
        >
          {Math.round(step.confidence * 100)}%
        </span>
        <span className="font-mono text-[10px] text-ink-tertiary">
          @ {formatMmSs(step.keyframeTimestampMs)}
        </span>
        {step.safetyCritical && (
          <span className="inline-flex items-center rounded-full bg-signal-warn/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal-warn">
            Safety
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp || locked}
            className="rounded p-1 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary disabled:opacity-30"
            aria-label="Move up"
          >
            ▲
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown || locked}
            className="rounded p-1 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary disabled:opacity-30"
            aria-label="Move down"
          >
            ▼
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={locked}
            className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault disabled:opacity-30"
            aria-label="Remove step"
          >
            <XCircle size={14} />
          </button>
        </div>
      </div>
      <TextInput
        value={step.title}
        onChange={(e) => onChange({ title: e.target.value })}
        disabled={locked}
        placeholder="Step title"
        className="!text-sm !font-semibold"
      />
      <Textarea
        value={step.voiceoverText}
        onChange={(e) => onChange({ voiceoverText: e.target.value })}
        disabled={locked}
        rows={3}
        className="mt-1.5 !text-xs"
        placeholder="Voiceover script (synthesized at execute time)"
      />
      {step.rationale && (
        <p className="mt-1 text-[10px] italic text-ink-tertiary">{step.rationale}</p>
      )}
    </div>
  );
}

function formatMmSs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}
