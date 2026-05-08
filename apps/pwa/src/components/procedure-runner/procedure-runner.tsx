'use client';

// ProcedureRunner — the interactive checklist runtime for
// kind=structured_procedure documents. Replaces the static-markdown
// rendering branch in docs-tab.tsx and parts-tab.tsx PartDocView.
//
// Lifecycle: mount calls startProcedureRun (idempotent on user/doc/asset).
// Per-step completion PATCHes happen on every "Mark done" tap so network
// drops or app closes don't lose evidence. The run finishes when all
// required steps have completions and the tech taps Finish.

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  ListChecks,
  Pause,
  Play,
  Ruler,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  abandonProcedureRun,
  finishProcedureRun,
  patchProcedureStep,
  pauseProcedureRun,
  resumeProcedureRun,
  startProcedureRun,
  uploadProcedureStepPhoto,
  type ProcedureBundle,
  type ProcedureMeasurementSpec,
  type ProcedureRunDto,
  type ProcedureStepCompletionDto,
  type ProcedureStepDto,
  type StepCompletionPayload,
} from '@/lib/api';

interface PhotoBuf {
  key: string;
  mime: string;
  url: string;
}

interface MeasurementDraft {
  numeric?: string; // raw input string for type=number
  passFail?: 'pass' | 'fail';
  freeText?: string;
  overrideReason?: string;
  outOfSpec?: boolean;
}

// Per-step draft snapshot persisted to localStorage so a tab close, app
// crash, or device reboot mid-step doesn't lose evidence the tech already
// captured. Keyed by runId+stepId so multiple in-flight runs stay distinct.
interface StepDraftSnapshot {
  measurement: MeasurementDraft;
  notes: string;
  photos: PhotoBuf[];
  enteredAtISO: string;
}

const DRAFT_STORAGE_VERSION = 1;
function draftStorageKey(runId: string, stepId: string): string {
  return `eh:proc-draft:v${DRAFT_STORAGE_VERSION}:${runId}:${stepId}`;
}

function loadDraft(runId: string, stepId: string): StepDraftSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(draftStorageKey(runId, stepId));
    if (!raw) return null;
    return JSON.parse(raw) as StepDraftSnapshot;
  } catch {
    return null;
  }
}

function saveDraft(runId: string, stepId: string, snap: StepDraftSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(draftStorageKey(runId, stepId), JSON.stringify(snap));
  } catch {
    // Quota exhaustion or storage disabled — silent fail; in-memory state still works.
  }
}

function clearDraft(runId: string, stepId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(draftStorageKey(runId, stepId));
  } catch {
    // ignore
  }
}

export function ProcedureRunner({
  docId,
  assetInstanceId,
  workOrderId,
  devUserId,
  devOrgId,
  onClose,
}: {
  docId: string;
  assetInstanceId?: string | null;
  workOrderId?: string | null;
  devUserId: string;
  devOrgId: string;
  onClose: () => void;
}) {
  const [bundle, setBundle] = useState<ProcedureBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [enteredAt, setEnteredAt] = useState<Date>(new Date());
  const [pendingPhotos, setPendingPhotos] = useState<PhotoBuf[]>([]);
  const [measurementDraft, setMeasurementDraft] = useState<MeasurementDraft>({});
  const [notesDraft, setNotesDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [missingStepIds, setMissingStepIds] = useState<string[] | null>(null);
  // Set when the most recent mark-done network call failed for a non-spec
  // reason (timeout, 5xx, connection drop). Drafts are persisted so the user
  // can simply tap "Retry" without re-entering anything.
  const [retryable, setRetryable] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lock body scroll while the runner is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Mount: start (or resume) the run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await startProcedureRun({
          docId,
          assetInstanceId,
          workOrderId,
          devUserId,
          devOrgId,
        });
        if (cancelled) return;
        setBundle(b);
        // If there are existing completions, advance to the first
        // un-completed step (resume position).
        const firstIncomplete = b.steps.findIndex(
          (s) => !b.completions.some((c) => c.stepId === s.id),
        );
        setCurrentStepIndex(firstIncomplete === -1 ? b.steps.length - 1 : firstIncomplete);
        setEnteredAt(new Date());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Reset per-step drafts when navigating between steps, AND rehydrate
  // any persisted draft snapshot for the new step. Draft persistence
  // means a tab close mid-step doesn't lose evidence — the runId+stepId
  // pair is stable across sessions because startProcedureRun is idempotent.
  useEffect(() => {
    setMissingStepIds(null);
    setRetryable(false);
    const runId = bundle?.run.id;
    const stepId = bundle?.steps[currentStepIndex]?.id;
    if (runId && stepId) {
      const restored = loadDraft(runId, stepId);
      if (restored) {
        setMeasurementDraft(restored.measurement);
        setNotesDraft(restored.notes);
        setPendingPhotos(restored.photos);
        setEnteredAt(new Date(restored.enteredAtISO));
        return;
      }
    }
    setEnteredAt(new Date());
    setPendingPhotos([]);
    setMeasurementDraft({});
    setNotesDraft('');
  }, [currentStepIndex, bundle?.run.id, bundle?.steps]);

  // Persist drafts on every change so a crash mid-step doesn't lose work.
  useEffect(() => {
    const runId = bundle?.run.id;
    const stepId = bundle?.steps[currentStepIndex]?.id;
    if (!runId || !stepId) return;
    // Skip persistence when there's nothing to persist (avoids writing
    // empty snapshots over a freshly-cleared step).
    const hasContent =
      pendingPhotos.length > 0 ||
      notesDraft.trim().length > 0 ||
      Boolean(
        measurementDraft.numeric ||
          measurementDraft.passFail ||
          measurementDraft.freeText ||
          measurementDraft.overrideReason,
      );
    if (!hasContent) return;
    saveDraft(runId, stepId, {
      measurement: measurementDraft,
      notes: notesDraft,
      photos: pendingPhotos,
      enteredAtISO: enteredAt.toISOString(),
    });
  }, [
    bundle?.run.id,
    bundle?.steps,
    currentStepIndex,
    pendingPhotos,
    notesDraft,
    measurementDraft,
    enteredAt,
  ]);

  if (error && !bundle) {
    return (
      <div className="doc-overlay" role="dialog" aria-modal="true">
        <ErrorScreen error={error} onClose={onClose} />
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="doc-overlay" role="dialog" aria-modal="true">
        <header className="doc-overlay-bar">
          <button
            type="button"
            onClick={onClose}
            className="app-topbar-btn"
            aria-label="Close"
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <div className="doc-overlay-title">
            <span className="caption">Procedure</span>
            <h2 className="truncate text-base font-semibold">Loading…</h2>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-tertiary">
          Loading procedure…
        </div>
      </div>
    );
  }

  const { run, document: doc, steps, completions } = bundle;
  const completionByStep = new Map(completions.map((c) => [c.stepId, c]));
  const stepMaybe = steps[currentStepIndex];
  if (!stepMaybe) {
    return (
      <div className="doc-overlay" role="dialog" aria-modal="true">
        <ErrorScreen
          error="Procedure has no steps."
          onClose={onClose}
        />
      </div>
    );
  }
  // Explicit non-undefined typing so closures defined below preserve the
  // narrowing across React renders / await boundaries / set-state callbacks.
  const step: ProcedureStepDto = stepMaybe;
  const currentBundle: ProcedureBundle = bundle;
  const existingCompletion = completionByStep.get(step.id) ?? null;
  const allDone = steps.every((s) => completionByStep.has(s.id));
  const isPaused = run.status === 'paused';
  const isCompleted = run.status === 'completed';
  const isAbandoned = run.status === 'abandoned';

  function updateBundle(next: Partial<ProcedureBundle>) {
    setBundle((prev) => (prev ? { ...prev, ...next } : prev));
  }

  function applyCompletion(c: ProcedureStepCompletionDto) {
    setBundle((prev) => {
      if (!prev) return prev;
      const others = prev.completions.filter((x) => x.stepId !== c.stepId);
      return { ...prev, completions: [...others, c] };
    });
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking same file
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const out = await uploadProcedureStepPhoto({
        runId: run.id,
        stepId: step.id,
        file,
        devUserId,
        devOrgId,
      });
      setPendingPhotos((prev) => [...prev, { key: out.key, mime: out.mime, url: out.url }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function removePendingPhoto(idx: number) {
    setPendingPhotos((prev) => prev.filter((_, i) => i !== idx));
  }

  function buildMeasurementForPayload(): StepCompletionPayload extends infer T
    ? T extends { measurement?: infer M }
      ? M
      : never
    : never {
    const spec = step.measurementSpec;
    if (!spec) return null as any;
    if (spec.kind === 'numeric') {
      const raw = measurementDraft.numeric;
      if (raw == null || raw === '') return null as any;
      const value = Number(raw);
      if (Number.isNaN(value)) return null as any;
      return {
        kind: 'numeric',
        value,
        ...(measurementDraft.overrideReason
          ? { overrideReason: measurementDraft.overrideReason }
          : {}),
      } as any;
    }
    if (spec.kind === 'pass_fail') {
      if (!measurementDraft.passFail) return null as any;
      return { kind: 'pass_fail', value: measurementDraft.passFail } as any;
    }
    if (spec.kind === 'free_text') {
      if (!measurementDraft.freeText) return null as any;
      return { kind: 'free_text', value: measurementDraft.freeText } as any;
    }
    return null as any;
  }

  function canMarkDone(): { ok: boolean; reason?: string } {
    if (isPaused) return { ok: false, reason: 'Run is paused.' };
    if (step.requiresPhoto) {
      const total = (existingCompletion?.photos.length ?? 0) + pendingPhotos.length;
      if (total < step.minPhotoCount) {
        return {
          ok: false,
          reason: `Need ${step.minPhotoCount - total} more photo${
            step.minPhotoCount - total === 1 ? '' : 's'
          }.`,
        };
      }
    }
    if (step.kind === 'measurement_required') {
      const m = buildMeasurementForPayload();
      if (!m) return { ok: false, reason: 'Enter measurement value.' };
    }
    return { ok: true };
  }

  async function onMarkDone() {
    setError(null);
    setRetryable(false);
    const photos = [
      ...(existingCompletion?.photos ?? []),
      ...pendingPhotos.map((p) => ({ key: p.key, mime: p.mime })),
    ];
    const payload: StepCompletionPayload = {
      outcome: 'completed',
      photos,
      measurement: buildMeasurementForPayload(),
      notes: notesDraft.trim() || undefined,
      enteredAt: enteredAt.toISOString(),
    };
    setBusy(true);
    try {
      const c = await patchProcedureStep({
        runId: run.id,
        stepId: step.id,
        payload,
        devUserId,
        devOrgId,
      });
      applyCompletion(c);
      // Server has the evidence. Clear the draft so a future re-entry of
      // this step doesn't re-hydrate stale local data.
      clearDraft(run.id, step.id);
      // Auto-advance to next incomplete step. Look at the just-completed
      // set (server completions + the new one) since the React state
      // hasn't re-rendered yet.
      const newCompletions = [
        ...currentBundle.completions.filter((x) => x.stepId !== c.stepId),
        c,
      ];
      const nextIdx = steps.findIndex(
        (s, i) =>
          i > currentStepIndex &&
          !newCompletions.some((x) => x.stepId === s.id),
      );
      if (nextIdx !== -1) {
        setCurrentStepIndex(nextIdx);
      } else if (currentStepIndex < steps.length - 1) {
        setCurrentStepIndex(currentStepIndex + 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface out-of-spec hint inline if the API rejected for that reason —
      // this isn't retryable, the user has to enter an override reason.
      if (msg.includes('out of spec')) {
        setMeasurementDraft((prev) => ({ ...prev, outOfSpec: true }));
        setError('Value is out of spec — confirm an override reason to continue.');
      } else {
        // Network / 5xx / unknown — drafts are already persisted, so a
        // simple retry button is safe and doesn't lose any captured evidence.
        setError(msg);
        setRetryable(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmSkip() {
    setError(null);
    if (!skipReason.trim()) {
      setError('Skip reason is required.');
      return;
    }
    if (step.safetyCritical && !notesDraft.trim()) {
      setError('Skipping a safety-critical step requires notes.');
      return;
    }
    const payload: StepCompletionPayload = {
      outcome: 'skipped',
      skipReason: skipReason.trim(),
      notes: notesDraft.trim() || undefined,
      enteredAt: enteredAt.toISOString(),
    };
    setBusy(true);
    try {
      const c = await patchProcedureStep({
        runId: run.id,
        stepId: step.id,
        payload,
        devUserId,
        devOrgId,
      });
      applyCompletion(c);
      clearDraft(run.id, step.id);
      setSkipDialogOpen(false);
      setSkipReason('');
      if (currentStepIndex < steps.length - 1) {
        setCurrentStepIndex(currentStepIndex + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onTogglePause() {
    setBusy(true);
    setError(null);
    try {
      const r = isPaused
        ? await resumeProcedureRun(run.id, devUserId, devOrgId)
        : await pauseProcedureRun(run.id, devUserId, devOrgId);
      updateBundle({ run: r });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFinish() {
    setBusy(true);
    setError(null);
    setMissingStepIds(null);
    try {
      const r = await finishProcedureRun(run.id, devUserId, devOrgId);
      updateBundle({ run: r });
    } catch (err) {
      const e = err as Error & { missingStepIds?: string[]; status?: number };
      if (e.missingStepIds) {
        setMissingStepIds(e.missingStepIds);
        setError(
          `Can't finish: ${e.missingStepIds.length} step${
            e.missingStepIds.length === 1 ? '' : 's'
          } still incomplete.`,
        );
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (isCompleted || isAbandoned) {
    return (
      <div className="doc-overlay" role="dialog" aria-modal="true" aria-label={doc.title}>
        <header className="doc-overlay-bar">
          <button
            type="button"
            onClick={onClose}
            className="app-topbar-btn"
            aria-label="Close"
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <div className="doc-overlay-title">
            <span className="caption">Procedure · {run.status}</span>
            <h2 className="truncate text-base font-semibold">{doc.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="app-topbar-btn"
            aria-label="Close"
          >
            <X size={20} strokeWidth={2} />
          </button>
        </header>
        <CompletionScreen
          run={run}
          steps={steps}
          completions={completions}
          onClose={onClose}
        />
      </div>
    );
  }

  const canDone = canMarkDone();

  return (
    <div className="doc-overlay" role="dialog" aria-modal="true" aria-label={doc.title}>
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onClose}
          className="app-topbar-btn"
          aria-label="Close procedure"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="inline-flex items-center gap-1.5 caption">
            <ListChecks size={12} strokeWidth={1.75} />
            Procedure
            <span className="ml-1 normal-case text-ink-tertiary">· {doc.title}</span>
          </span>
          <h2 className="truncate text-base font-semibold">
            Step {String(currentStepIndex + 1).padStart(2, '0')} of{' '}
            {String(steps.length).padStart(2, '0')} — {step.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onTogglePause}
          className="app-topbar-btn"
          aria-label={isPaused ? 'Resume' : 'Pause'}
          disabled={busy}
        >
          {isPaused ? <Play size={20} strokeWidth={2} /> : <Pause size={20} strokeWidth={2} />}
        </button>
      </header>

      <ProgressStrip
        steps={steps}
        completions={completions}
        currentIndex={currentStepIndex}
        onJump={(i) => setCurrentStepIndex(i)}
      />

      <div className="doc-overlay-scroll">
        {error && (
          <div className="mx-auto mt-3 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
            <span className="min-w-0 flex-1">{error}</span>
            {retryable && (
              <button
                type="button"
                onClick={onMarkDone}
                disabled={busy}
                className="btn btn-sm btn-outline shrink-0"
              >
                Retry
              </button>
            )}
          </div>
        )}
        {missingStepIds && (
          <div className="mx-auto mt-3 max-w-3xl rounded-md border border-signal-warn/40 bg-signal-warn/10 p-3 text-sm">
            <p className="font-medium text-signal-warn">Incomplete steps</p>
            <p className="mt-0.5 text-ink-secondary">
              Tap a number above to jump back to a missing step.
            </p>
          </div>
        )}

        {step.safetyCritical && (
          <div className="mx-auto mt-4 max-w-3xl rounded-md border border-signal-safety/50 bg-signal-safety/10 p-4">
            <div className="flex items-start gap-3">
              <ShieldAlert
                size={20}
                strokeWidth={2}
                className="mt-0.5 text-signal-safety"
              />
              <div>
                <p className="font-semibold text-signal-safety">Safety-critical</p>
                <p className="text-sm text-ink-secondary">
                  Follow verbatim. If unsure, stop and ask. Skipping requires a
                  written reason.
                </p>
              </div>
            </div>
          </div>
        )}

        <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={step.kind} />
            {existingCompletion && (
              <span className="caption normal-case text-ink-tertiary">
                · {existingCompletion.outcome === 'skipped' ? 'Skipped earlier' : 'Completed earlier'}
              </span>
            )}
          </div>

          <h3 className="text-2xl font-semibold text-ink-primary">{step.title}</h3>

          {step.bodyMarkdown && (
            <div className="markdown-body text-base">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {step.bodyMarkdown}
              </ReactMarkdown>
            </div>
          )}

          {step.requiresPhoto && (
            <PhotoBlock
              minCount={step.minPhotoCount}
              existing={existingCompletion?.photos ?? []}
              pending={pendingPhotos}
              onAdd={() => fileInputRef.current?.click()}
              onRemovePending={removePendingPhoto}
              busy={busy}
            />
          )}

          {step.measurementSpec && (
            <MeasurementBlock
              spec={step.measurementSpec}
              draft={measurementDraft}
              onChange={setMeasurementDraft}
            />
          )}

          <label className="flex flex-col gap-1.5">
            <span className="caption">Notes (optional)</span>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              rows={2}
              placeholder={
                step.safetyCritical
                  ? 'Add notes (required if you skip)'
                  : 'Anything different than the manual?'
              }
              className="rounded border border-line bg-surface-raised p-3 text-sm"
            />
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onPickPhoto}
            className="hidden"
          />
        </main>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface-raised px-4 py-3">
        <button
          type="button"
          onClick={() => setSkipDialogOpen(true)}
          className="btn btn-ghost"
          disabled={busy || isPaused}
        >
          Skip…
        </button>
        <div className="flex items-center gap-2">
          {currentStepIndex > 0 && (
            <button
              type="button"
              onClick={() => setCurrentStepIndex(currentStepIndex - 1)}
              className="btn btn-secondary"
              disabled={busy}
            >
              <ChevronLeft size={16} strokeWidth={2} /> Prev
            </button>
          )}
          {allDone ? (
            <button
              type="button"
              onClick={onFinish}
              className="btn btn-primary"
              disabled={busy}
            >
              <Check size={16} strokeWidth={2} /> Finish run
            </button>
          ) : (
            <button
              type="button"
              onClick={onMarkDone}
              className="btn btn-primary"
              disabled={busy || !canDone.ok}
              title={canDone.ok ? 'Mark this step done' : canDone.reason}
            >
              Mark done <ChevronRight size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      </footer>

      {skipDialogOpen && (
        <SkipDialog
          step={step}
          skipReason={skipReason}
          notes={notesDraft}
          onChangeReason={setSkipReason}
          onChangeNotes={setNotesDraft}
          onCancel={() => setSkipDialogOpen(false)}
          onConfirm={onConfirmSkip}
          busy={busy}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: ProcedureStepDto['kind'] }) {
  const Icon =
    kind === 'photo_required'
      ? Camera
      : kind === 'measurement_required'
        ? Ruler
        : kind === 'safety_check'
          ? ShieldAlert
          : ClipboardCheck;
  const label =
    kind === 'photo_required'
      ? 'PHOTO REQUIRED'
      : kind === 'measurement_required'
        ? 'MEASUREMENT'
        : kind === 'safety_check'
          ? 'SAFETY CHECK'
          : 'INSTRUCTION';
  return (
    <span className="inline-flex items-center gap-1.5 caption">
      <Icon size={12} strokeWidth={1.75} />
      {label}
    </span>
  );
}

function ProgressStrip({
  steps,
  completions,
  currentIndex,
  onJump,
}: {
  steps: ProcedureStepDto[];
  completions: ProcedureStepCompletionDto[];
  currentIndex: number;
  onJump: (i: number) => void;
}) {
  const completionByStep = useMemo(
    () => new Map(completions.map((c) => [c.stepId, c])),
    [completions],
  );
  return (
    <nav
      aria-label="Procedure steps"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface-elevated px-3 py-2"
    >
      {steps.map((s, i) => {
        const c = completionByStep.get(s.id);
        const isCurrent = i === currentIndex;
        const isDone = c?.outcome === 'completed';
        const isSkipped = c?.outcome === 'skipped';
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onJump(i)}
            className={`flex h-8 min-w-[2rem] items-center justify-center rounded-md border px-1.5 font-mono text-xs tabular-nums transition ${
              isCurrent
                ? 'border-brand bg-brand/10 text-brand'
                : isDone
                  ? 'border-signal-ok/40 bg-signal-ok/10 text-signal-ok'
                  : isSkipped
                    ? 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
                    : 'border-line bg-surface-raised text-ink-tertiary'
            }`}
            aria-label={`Step ${i + 1} — ${s.title}${isDone ? ' (done)' : isSkipped ? ' (skipped)' : ''}`}
            aria-current={isCurrent ? 'step' : undefined}
          >
            {isDone ? (
              <Check size={12} strokeWidth={2} />
            ) : (
              <span>{String(i + 1).padStart(2, '0')}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function PhotoBlock({
  minCount,
  existing,
  pending,
  onAdd,
  onRemovePending,
  busy,
}: {
  minCount: number;
  existing: Array<{ key: string; mime: string }>;
  pending: PhotoBuf[];
  onAdd: () => void;
  onRemovePending: (idx: number) => void;
  busy: boolean;
}) {
  const total = existing.length + pending.length;
  const need = Math.max(0, minCount - total);
  return (
    <section className="rounded-md border border-line bg-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="caption">
          PHOTO EVIDENCE
          {minCount > 0 && (
            <span className="ml-2 normal-case text-ink-tertiary">
              {need > 0 ? `${need} required` : `OK (${total} captured)`}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onAdd}
          className="btn btn-secondary btn-sm"
          disabled={busy}
        >
          <Camera size={14} strokeWidth={2} /> Add photo
        </button>
      </div>
      {total === 0 ? (
        <p className="text-sm text-ink-tertiary">No photos yet — tap Add photo.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {existing.map((p, i) => (
            <li
              key={`e-${i}`}
              className="relative flex aspect-square flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md border border-signal-ok/30 bg-signal-ok/10 text-signal-ok"
              aria-label="Photo saved"
            >
              <Check size={20} strokeWidth={2.25} />
              <span className="font-mono text-[10px] uppercase tracking-wider opacity-80">
                Saved
              </span>
            </li>
          ))}
          {pending.map((p, i) => (
            <li
              key={`p-${i}`}
              className="relative aspect-square overflow-hidden rounded-md border border-line"
            >
              <img src={p.url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemovePending(i)}
                className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition hover:bg-black/80"
                aria-label="Remove photo"
              >
                <X size={12} strokeWidth={2.25} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MeasurementBlock({
  spec,
  draft,
  onChange,
}: {
  spec: ProcedureMeasurementSpec;
  draft: MeasurementDraft;
  onChange: (next: MeasurementDraft) => void;
}) {
  return (
    <section className="rounded-md border border-line bg-surface-raised p-4">
      <span className="caption">MEASUREMENT</span>
      <p className="mt-1 mb-3 text-base font-medium text-ink-primary">{spec.label}</p>
      {spec.kind === 'numeric' && (
        <NumericInput spec={spec} draft={draft} onChange={onChange} />
      )}
      {spec.kind === 'pass_fail' && (
        <PassFailInput spec={spec} draft={draft} onChange={onChange} />
      )}
      {spec.kind === 'free_text' && (
        <FreeTextInput spec={spec} draft={draft} onChange={onChange} />
      )}
    </section>
  );
}

function NumericInput({
  spec,
  draft,
  onChange,
}: {
  spec: Extract<ProcedureMeasurementSpec, { kind: 'numeric' }>;
  draft: MeasurementDraft;
  onChange: (next: MeasurementDraft) => void;
}) {
  const value = draft.numeric ?? '';
  const num = value === '' ? null : Number(value);
  const outOfSpec =
    num != null &&
    !Number.isNaN(num) &&
    ((spec.min != null && num < spec.min) || (spec.max != null && num > spec.max));
  const rangeLabel = (() => {
    if (spec.min != null && spec.max != null) return `Range: ${spec.min} – ${spec.max} ${spec.unit}`;
    if (spec.min != null) return `≥ ${spec.min} ${spec.unit}`;
    if (spec.max != null) return `≤ ${spec.max} ${spec.unit}`;
    if (spec.expected != null) return `Target: ${spec.expected} ${spec.unit}`;
    return spec.unit;
  })();
  return (
    <>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={value}
          onChange={(e) =>
            onChange({ ...draft, numeric: e.target.value, outOfSpec: undefined })
          }
          className="form-input flex-1 font-mono tabular-nums"
          placeholder="—"
        />
        <span className="font-mono text-sm text-ink-tertiary">{spec.unit}</span>
      </div>
      <p className="mt-1 font-mono text-xs text-ink-tertiary">{rangeLabel}</p>
      {outOfSpec && (
        <div className="mt-3 rounded border border-signal-warn/40 bg-signal-warn/10 p-3">
          <p className="text-sm font-medium text-signal-warn">Out of spec</p>
          <p className="mt-1 text-xs text-ink-secondary">
            Confirm an override reason to proceed. The value + reason will be
            recorded.
          </p>
          <textarea
            value={draft.overrideReason ?? ''}
            onChange={(e) => onChange({ ...draft, overrideReason: e.target.value })}
            rows={2}
            placeholder="Why is this still acceptable?"
            className="mt-2 w-full rounded border border-line bg-surface-raised p-2 text-sm"
          />
        </div>
      )}
    </>
  );
}

function PassFailInput({
  spec,
  draft,
  onChange,
}: {
  spec: Extract<ProcedureMeasurementSpec, { kind: 'pass_fail' }>;
  draft: MeasurementDraft;
  onChange: (next: MeasurementDraft) => void;
}) {
  const passLabel = spec.passLabel ?? 'Pass';
  const failLabel = spec.failLabel ?? 'Fail';
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={() => onChange({ ...draft, passFail: 'pass' })}
        className={`btn ${draft.passFail === 'pass' ? 'btn-primary' : 'btn-secondary'} h-12`}
      >
        <Check size={16} strokeWidth={2} /> {passLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange({ ...draft, passFail: 'fail' })}
        className={`btn ${draft.passFail === 'fail' ? 'btn-danger' : 'btn-secondary'} h-12`}
      >
        <X size={16} strokeWidth={2} /> {failLabel}
      </button>
    </div>
  );
}

function FreeTextInput({
  spec,
  draft,
  onChange,
}: {
  spec: Extract<ProcedureMeasurementSpec, { kind: 'free_text' }>;
  draft: MeasurementDraft;
  onChange: (next: MeasurementDraft) => void;
}) {
  return (
    <textarea
      value={draft.freeText ?? ''}
      onChange={(e) => onChange({ ...draft, freeText: e.target.value })}
      rows={2}
      maxLength={spec.maxLen ?? 500}
      placeholder={spec.placeholder ?? ''}
      className="form-textarea w-full"
    />
  );
}

function SkipDialog({
  step,
  skipReason,
  notes,
  onChangeReason,
  onChangeNotes,
  onCancel,
  onConfirm,
  busy,
}: {
  step: ProcedureStepDto;
  skipReason: string;
  notes: string;
  onChangeReason: (s: string) => void;
  onChangeNotes: (s: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-md border border-line bg-surface-raised p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-ink-primary">
          Skip step — {step.title}?
        </h3>
        {step.safetyCritical && (
          <p className="mt-2 rounded border border-signal-safety/40 bg-signal-safety/10 p-2 text-xs text-signal-safety">
            This step is safety-critical. Notes are required.
          </p>
        )}
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="caption">Reason for skipping</span>
          <textarea
            value={skipReason}
            onChange={(e) => onChangeReason(e.target.value)}
            rows={2}
            placeholder="Part already replaced last week"
            className="form-textarea"
          />
        </label>
        {step.safetyCritical && (
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="caption">Notes (required)</span>
            <textarea
              value={notes}
              onChange={(e) => onChangeNotes(e.target.value)}
              rows={2}
              placeholder="Confirmed by supervisor; LOTO already verified."
              className="form-textarea"
            />
          </label>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn btn-warn"
            disabled={busy}
          >
            Skip step
          </button>
        </div>
      </div>
    </div>
  );
}

function CompletionScreen({
  run,
  steps,
  completions,
  onClose,
}: {
  run: ProcedureRunDto;
  steps: ProcedureStepDto[];
  completions: ProcedureStepCompletionDto[];
  onClose: () => void;
}) {
  const completedCount = completions.filter((c) => c.outcome === 'completed').length;
  const skippedCount = completions.filter((c) => c.outcome === 'skipped').length;
  return (
    <div className="doc-overlay-scroll">
      <main className="mx-auto flex max-w-2xl flex-col items-center gap-5 px-4 py-12 text-center">
        {run.status === 'completed' ? (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-signal-ok/10 text-signal-ok">
              <Check size={32} strokeWidth={2} />
            </div>
            <h2 className="text-2xl font-semibold text-ink-primary">Procedure complete</h2>
            <p className="text-sm text-ink-secondary">
              {completedCount} step{completedCount === 1 ? '' : 's'} completed
              {skippedCount > 0 && `, ${skippedCount} skipped`}.
            </p>
          </>
        ) : (
          <>
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-signal-warn/10 text-signal-warn">
              <CircleDot size={32} strokeWidth={2} />
            </div>
            <h2 className="text-2xl font-semibold text-ink-primary">Procedure abandoned</h2>
            {run.abandonedReason && (
              <p className="text-sm text-ink-secondary">Reason: {run.abandonedReason}</p>
            )}
          </>
        )}
        <button type="button" onClick={onClose} className="btn btn-primary mt-4">
          Done
        </button>
      </main>
    </div>
  );
}

function ErrorScreen({
  error,
  onClose,
}: {
  error: string;
  onClose: () => void;
}) {
  return (
    <>
      <header className="doc-overlay-bar">
        <button type="button" onClick={onClose} className="app-topbar-btn" aria-label="Close">
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="caption">Procedure</span>
          <h2 className="truncate text-base font-semibold">Couldn't load run</h2>
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-signal-fault">{error}</p>
        <button type="button" onClick={onClose} className="btn btn-secondary">
          Back
        </button>
      </div>
    </>
  );
}
