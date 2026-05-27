'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clapperboard,
  Film,
  Layers,
  Loader2,
  Play,
  Rocket,
  Smartphone,
  Tablet,
  Wrench,
  XCircle,
  Zap,
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
  setProcedureDraftCategory,
  type AdminDraftDetail,
  type AdminDraftProposalTree,
  type AdminDraftStepProposal,
  type ProcedureDraftCategory,
} from '@/lib/api';
import { MuxClipAudioPreview } from '@/components/mux-clip-audio-preview';
import { ClipTrimSlider } from '@/components/clip-trim-slider';
import { formatMmSs, formatClipDuration } from '@/lib/clip-time';

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
    if (!detail?.run.procedureCategory) {
      toast.error(
        'Pick a category first',
        'PM / R&R / Troubleshooting / Walkthrough — pick one before running the AI so the prompt biases the right way.',
      );
      return;
    }
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

  async function setCategory(category: ProcedureDraftCategory | null) {
    if (!detail) return;
    setBusy(true);
    try {
      await setProcedureDraftCategory(runId, category);
      setDetail({
        ...detail,
        run: { ...detail.run, procedureCategory: category },
      });
    } catch (e) {
      toast.error('Set category failed', e instanceof Error ? e.message : String(e));
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
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 text-ink-secondary">
              <Clapperboard size={14} /> AI procedure drafter
            </span>
            {detail?.run.sourceVideoOrientation && (
              <Chip>
                {detail.run.sourceVideoOrientation === 'portrait' ? (
                  <Smartphone size={11} />
                ) : (
                  <Tablet size={11} />
                )}
                <span className="capitalize">
                  {detail.run.sourceVideoOrientation}
                </span>
                {detail.run.sourceVideoAspectRatio && (
                  <span className="text-ink-tertiary">
                    · {detail.run.sourceVideoAspectRatio}
                  </span>
                )}
              </Chip>
            )}
            {detail?.run.procedureCategory && (
              <Chip tone="accent">
                {CATEGORY_LABEL[detail.run.procedureCategory]}
              </Chip>
            )}
            {detail?.run.transcriptSource && (
              <Chip>transcript: {detail.run.transcriptSource}</Chip>
            )}
            {detail?.proposal?.tokenUsage && (
              <Chip>
                tokens: {detail.proposal.tokenUsage.inputTokens}/
                {detail.proposal.tokenUsage.outputTokens}
              </Chip>
            )}
          </div>
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
        <PendingDecisionPanel
          detail={detail}
          runId={runId}
          onSetCategory={(c) => void setCategory(c)}
          busy={busy}
        />
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
              <div
                className="sticky top-3 z-10 overflow-hidden rounded-md border border-line bg-black"
                style={{
                  aspectRatio: aspectRatioFor(
                    detail.run.sourceVideoAspectRatio,
                    detail.run.sourceVideoOrientation,
                  ),
                  ...(detail.run.sourceVideoOrientation === 'portrait'
                    ? { maxWidth: '420px', marginInline: 'auto' }
                    : {}),
                }}
              >
                <video
                  controls
                  preload="metadata"
                  className="h-full w-full object-contain"
                  src={`https://stream.mux.com/${detail.playbackId}/low.mp4`}
                />
              </div>
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
          <aside className="flex flex-col gap-3">
            <CategoryBanner
              category={detail.run.procedureCategory}
              onChange={(c) => void setCategory(c)}
              disabled={busy || phase !== 'ready'}
            />
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
            <SectionedSteps
              steps={draftSteps}
              category={detail.run.procedureCategory}
              playbackId={detail.playbackId}
              aspectRatio={detail.run.sourceVideoAspectRatio}
              orientation={detail.run.sourceVideoOrientation}
              sourceDurationMs={detail.run.sourceVideoDurationMs}
              locked={phase !== 'ready'}
              onUpdate={updateStep}
              onRemove={removeStep}
              onMove={moveStep}
            />
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
  runId: _runId,
  onSetCategory,
  busy,
}: {
  detail: AdminDraftDetail;
  runId: string;
  onSetCategory: (c: ProcedureDraftCategory | null) => void;
  busy: boolean;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <main className="flex flex-col gap-3">
        {detail.playbackId && (
          <div
            className="relative w-full overflow-hidden rounded-md border border-line bg-black"
            style={{
              aspectRatio: aspectRatioFor(
                detail.run.sourceVideoAspectRatio,
                detail.run.sourceVideoOrientation,
              ),
              ...(detail.run.sourceVideoOrientation === 'portrait'
                ? { maxWidth: '420px', marginInline: 'auto' }
                : {}),
            }}
          >
            <video
              controls
              preload="metadata"
              className="h-full w-full object-contain"
              src={`https://stream.mux.com/${detail.playbackId}/low.mp4`}
            />
          </div>
        )}
        {detail.transcript ? (
          <details
            className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-secondary"
            open
          >
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
        <CategoryPicker
          value={detail.run.procedureCategory}
          onChange={onSetCategory}
          disabled={busy}
        />
        <div className="rounded-md border border-line bg-surface-raised px-3 py-3 text-xs">
          <p className="font-semibold text-ink-primary">Ready for your decision</p>
          <p className="mt-1 text-ink-secondary">
            A tech submitted this walkthrough from the PWA. Pick a
            category, watch the clip, then:
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
          {!detail.run.procedureCategory && (
            <p className="mt-2 rounded border border-signal-warn/30 bg-signal-warn/5 px-2 py-1.5 text-[11px] text-signal-warn">
              Pick a category before tapping Run AI — the prompt depends on it.
            </p>
          )}
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
  playbackId,
  aspectRatio,
  orientation,
  sourceDurationMs,
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
  playbackId: string | null;
  aspectRatio: string | null;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  /** Full source video duration in ms. When known we use it as the
   *  upper bound of the trim slider so the reviewer can drag handles
   *  anywhere in the source; otherwise the slider falls back to a
   *  context window around the current clip. */
  sourceDurationMs: number | null;
  onChange: (patch: Partial<AdminDraftStepProposal>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  // Live playhead from the per-step preview player, threaded into the
  // trim slider so the reviewer can see where the loop currently is on
  // the timeline. Null while the player is inactive.
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
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
        {/* Clip range chip — exposes the per-step Mux clip window the
            drafter picked. Tap-to-edit so reviewers can fine-tune the
            range before executing (e.g., extend a too-short cut, or
            trim a clip that drifted into the next step). */}
        <span
          className="inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent"
          title={`Clip range: ${formatMmSs(step.clipStartMs)} → ${formatMmSs(step.clipEndMs)} (${formatClipDuration(step.clipEndMs - step.clipStartMs)})`}
        >
          ▶ {formatMmSs(step.clipStartMs)}–{formatMmSs(step.clipEndMs)}
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
      {playbackId && (
        <div className="mb-2 mt-1">
          <MuxClipAudioPreview
            playbackId={playbackId}
            startMs={step.clipStartMs}
            endMs={step.clipEndMs}
            aspectRatio={aspectRatio}
            orientation={orientation}
            // Drafts have no synthesized voiceover yet (TTS happens at
            // execute time, per the textarea hint below). Leave
            // voiceoverUrl undefined so the player plays the source
            // audio — that's the captured tech narration, which is the
            // closest reviewable approximation of what the final
            // voiceover will say.
            onTimeUpdate={(ms) => setPlayheadMs(ms)}
          />
        </div>
      )}
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
      {/* Drag-to-trim handles. When sourceDurationMs is known, the
          slider spans the whole source so the reviewer can drag handles
          anywhere; otherwise it falls back to a context window around
          the current clip (±15s) which is plenty for normal trim work.
          Server validation still gates the final save. */}
      <div className="mt-1.5">
        <ClipTrimSlider
          startMs={step.clipStartMs}
          endMs={step.clipEndMs}
          timelineStartMs={
            sourceDurationMs ? 0 : Math.max(0, step.clipStartMs - 15_000)
          }
          timelineEndMs={
            sourceDurationMs ?? step.clipEndMs + 15_000
          }
          disabled={locked}
          playheadMs={playheadMs}
          onChange={(next) =>
            onChange({
              clipStartMs: next.startMs,
              clipEndMs: next.endMs,
            })
          }
        />
      </div>
      {step.rationale && (
        <p className="mt-1 text-[10px] italic text-ink-tertiary">{step.rationale}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category picker, banner, chips, section grouping
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<ProcedureDraftCategory, string> = {
  preventive_maintenance: 'Preventive Maintenance',
  removal_replacement: 'Removal & Replacement',
  troubleshooting: 'Troubleshooting',
  walkthrough: 'Walkthrough',
};

const CATEGORY_OPTIONS: Array<{
  value: ProcedureDraftCategory;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'preventive_maintenance',
    label: 'Preventive Maintenance',
    hint: 'Scheduled, no part swap. Pre-check → inspect → restore.',
    icon: <Wrench size={14} />,
  },
  {
    value: 'removal_replacement',
    label: 'Removal & Replacement',
    hint: 'Old part out, new part in. Auto-splits into 2 sections.',
    icon: <Layers size={14} />,
  },
  {
    value: 'troubleshooting',
    label: 'Troubleshooting',
    hint: 'Observe → measure → branch. Numeric thresholds favored.',
    icon: <Zap size={14} />,
  },
  {
    value: 'walkthrough',
    label: 'Walkthrough',
    hint: 'Freeform narration. One step per demonstrated action.',
    icon: <Play size={14} />,
  },
];

function Chip({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'accent';
}) {
  const cls =
    tone === 'accent'
      ? 'bg-accent/10 text-accent border-accent/30'
      : 'bg-surface-elevated text-ink-secondary border-line';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

function CategoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: ProcedureDraftCategory | null;
  onChange: (c: ProcedureDraftCategory | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-raised px-3 py-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          Procedure category
        </p>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className="text-[10px] font-medium text-ink-tertiary underline hover:text-ink-primary disabled:opacity-30"
          >
            Clear
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-1.5">
        {CATEGORY_OPTIONS.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={[
                'group flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition',
                active
                  ? 'border-accent bg-accent/10'
                  : 'border-line bg-surface hover:border-accent/40 hover:bg-accent/5',
                disabled ? 'opacity-50' : '',
              ].join(' ')}
              aria-pressed={active}
            >
              <span
                className={[
                  'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px]',
                  active
                    ? 'bg-accent text-white'
                    : 'bg-surface-elevated text-ink-secondary group-hover:bg-accent/20 group-hover:text-accent',
                ].join(' ')}
              >
                {opt.icon}
              </span>
              <span className="min-w-0">
                <span
                  className={[
                    'block text-xs font-semibold',
                    active ? 'text-accent' : 'text-ink-primary',
                  ].join(' ')}
                >
                  {opt.label}
                </span>
                <span className="block text-[10px] leading-snug text-ink-tertiary">
                  {opt.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CategoryBanner({
  category,
  onChange,
  disabled,
}: {
  category: ProcedureDraftCategory | null;
  onChange: (c: ProcedureDraftCategory | null) => void;
  disabled?: boolean;
}) {
  // Inline compact picker for the reviewer aside — same options as the
  // pending-decision panel, but condensed to a row of pills so the
  // primary focus stays on the step tree.
  return (
    <div className="rounded-md border border-line bg-surface-raised px-2.5 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
        Category
      </p>
      <div className="flex flex-wrap gap-1">
        {CATEGORY_OPTIONS.map((opt) => {
          const active = category === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(active ? null : opt.value)}
              disabled={disabled}
              className={[
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition',
                active
                  ? 'border-accent bg-accent text-white'
                  : 'border-line bg-surface text-ink-secondary hover:border-accent/40 hover:text-ink-primary',
                disabled ? 'opacity-50' : '',
              ].join(' ')}
              title={opt.hint}
              aria-pressed={active}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Detect whether a step belongs to the Removal or Replacement phase of
// an R&R procedure. Mirrors the heuristic the LLM prompt requests
// ("first-word convention"). Falls back to "Removal" for unmatched
// titles in the first half of the step list and "Replacement" in the
// second half — best-effort so the section UI never silently drops a
// step.
const REMOVAL_VERBS = new Set([
  'remove',
  'disconnect',
  'loosen',
  'unscrew',
  'lift',
  'pull',
  'unbolt',
  'detach',
  'unplug',
  'extract',
  'drain',
  'open',
  'unlock',
  'release',
]);
const REPLACEMENT_VERBS = new Set([
  'install',
  'connect',
  'tighten',
  'screw',
  'seat',
  'attach',
  'plug',
  'fasten',
  'replace',
  'mount',
  'close',
  'secure',
  'torque',
  'reapply',
]);

function classifyRrPhase(
  step: AdminDraftStepProposal,
  index: number,
  total: number,
): 'removal' | 'replacement' | 'verify' {
  const firstWord = step.title.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (REMOVAL_VERBS.has(firstWord)) return 'removal';
  if (REPLACEMENT_VERBS.has(firstWord)) return 'replacement';
  if (/verify|confirm|check|test/i.test(step.title)) return 'verify';
  // Positional fallback: first half assumed removal, second half assumed
  // replacement. The admin can drag-reorder if the heuristic miscalls.
  return index < total / 2 ? 'removal' : 'replacement';
}

function SectionedSteps({
  steps,
  category,
  playbackId,
  aspectRatio,
  orientation,
  sourceDurationMs,
  locked,
  onUpdate,
  onRemove,
  onMove,
}: {
  steps: AdminDraftStepProposal[];
  category: ProcedureDraftCategory | null;
  playbackId: string | null;
  aspectRatio: string | null;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  sourceDurationMs: number | null;
  locked: boolean;
  onUpdate: (id: string, patch: Partial<AdminDraftStepProposal>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  // R&R groups into Removal / Replacement; other categories render a
  // single flat list. We compute index lookups so the move handlers
  // still operate on the global step order even when rendered by group.
  if (category !== 'removal_replacement') {
    return (
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={step.clientId}>
            <DraftStepCard
              step={step}
              index={i}
              canMoveUp={i > 0}
              canMoveDown={i < steps.length - 1}
              locked={locked}
              playbackId={playbackId}
              aspectRatio={aspectRatio}
              orientation={orientation}
              sourceDurationMs={sourceDurationMs}
              onChange={(patch) => onUpdate(step.clientId, patch)}
              onRemove={() => onRemove(step.clientId)}
              onMoveUp={() => onMove(step.clientId, -1)}
              onMoveDown={() => onMove(step.clientId, 1)}
            />
          </li>
        ))}
      </ol>
    );
  }

  const phases = steps.map((s, i) => classifyRrPhase(s, i, steps.length));
  const removal: Array<{ step: AdminDraftStepProposal; absoluteIndex: number }> = [];
  const replacement: Array<{ step: AdminDraftStepProposal; absoluteIndex: number }> = [];
  const verify: Array<{ step: AdminDraftStepProposal; absoluteIndex: number }> = [];
  steps.forEach((s, i) => {
    const p = phases[i];
    const target = p === 'removal' ? removal : p === 'replacement' ? replacement : verify;
    target.push({ step: s, absoluteIndex: i });
  });

  return (
    <div className="flex flex-col gap-3">
      <SectionGroup
        title="Removal"
        accent="bg-signal-warn/15 text-signal-warn"
        items={removal}
        steps={steps}
        locked={locked}
        playbackId={playbackId}
        aspectRatio={aspectRatio}
        orientation={orientation}
        sourceDurationMs={sourceDurationMs}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onMove={onMove}
      />
      <SectionGroup
        title="Replacement"
        accent="bg-signal-ok/15 text-signal-ok"
        items={replacement}
        steps={steps}
        locked={locked}
        playbackId={playbackId}
        aspectRatio={aspectRatio}
        orientation={orientation}
        sourceDurationMs={sourceDurationMs}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onMove={onMove}
      />
      {verify.length > 0 && (
        <SectionGroup
          title="Verify"
          accent="bg-accent/15 text-accent"
          items={verify}
          steps={steps}
          locked={locked}
          playbackId={playbackId}
          aspectRatio={aspectRatio}
          orientation={orientation}
          sourceDurationMs={sourceDurationMs}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onMove={onMove}
        />
      )}
      <p className="text-[10px] italic text-ink-tertiary">
        Sections are heuristic (first-word of each title). Drag with ▲▼ or
        edit the title to reassign a step.
      </p>
    </div>
  );
}

function SectionGroup({
  title,
  accent,
  items,
  steps,
  locked,
  playbackId,
  aspectRatio,
  orientation,
  sourceDurationMs,
  onUpdate,
  onRemove,
  onMove,
}: {
  title: string;
  accent: string;
  items: Array<{ step: AdminDraftStepProposal; absoluteIndex: number }>;
  steps: AdminDraftStepProposal[];
  locked: boolean;
  playbackId: string | null;
  aspectRatio: string | null;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  sourceDurationMs: number | null;
  onUpdate: (id: string, patch: Partial<AdminDraftStepProposal>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3
        className={`mb-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${accent}`}
      >
        {title} · {items.length}
      </h3>
      <ol className="flex flex-col gap-2">
        {items.map(({ step, absoluteIndex }) => (
          <li key={step.clientId}>
            <DraftStepCard
              step={step}
              index={absoluteIndex}
              canMoveUp={absoluteIndex > 0}
              canMoveDown={absoluteIndex < steps.length - 1}
              locked={locked}
              playbackId={playbackId}
              aspectRatio={aspectRatio}
              orientation={orientation}
              sourceDurationMs={sourceDurationMs}
              onChange={(patch) => onUpdate(step.clientId, patch)}
              onRemove={() => onRemove(step.clientId)}
              onMoveUp={() => onMove(step.clientId, -1)}
              onMoveDown={() => onMove(step.clientId, 1)}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function aspectRatioFor(
  ratio: string | null,
  orientation: 'portrait' | 'landscape' | 'square' | null,
): string {
  if (ratio) {
    const m = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (m) return `${m[1]} / ${m[2]}`;
  }
  if (orientation === 'portrait') return '9 / 16';
  if (orientation === 'square') return '1 / 1';
  return '16 / 9';
}

// mm:ss + duration helpers now live in @/lib/clip-time so the published
// step editor can share the same parsing rules — see imports above.
