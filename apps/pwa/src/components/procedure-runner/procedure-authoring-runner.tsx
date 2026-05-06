'use client';

// ProcedureAuthoringRunner — capture-as-you-go authoring for field-
// authored procedures. The tech walks through their work step-by-step;
// each step is added server-side immediately (POST /authoring-steps),
// then the existing PATCH /steps/:stepId records the evidence
// (photo / measurement / notes). This makes the first run of a brand-
// new procedure both the authoring AND the first execution.
//
// State machine: starts a run via POST /asset-instances/:id/field-
// procedures. Loops on (capture step → record evidence). Finishes via
// POST /authoring-finalize (sets title, scope, parts) then POST /finish
// (run.status → completed). Cancel = abandon.

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ListChecks,
  Plus,
  Ruler,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  abandonProcedureRun,
  addAuthoringStep,
  finalizeAuthoring,
  finishProcedureRun,
  patchProcedureStep,
  startFieldProcedure,
  uploadProcedureStepPhoto,
  type ProcedureBundle,
  type ProcedureMeasurementSpec,
  type ProcedureStepDto,
  type ProcedureStepKind,
  type StepCompletionPayload,
} from '@/lib/api';

const KIND_OPTIONS: Array<{ value: ProcedureStepKind; label: string }> = [
  { value: 'instruction', label: 'Instruction (read & tap)' },
  { value: 'safety_check', label: 'Safety check' },
  { value: 'photo_required', label: 'Photo required' },
  { value: 'measurement_required', label: 'Measurement required' },
];

interface PhotoBuf {
  key: string;
  mime: string;
  url: string;
}

interface DraftStep {
  // Author-side fields, set in the input form.
  kind: ProcedureStepKind;
  title: string;
  bodyMarkdown: string;
  safetyCritical: boolean;
  requiresPhoto: boolean;
  minPhotoCount: number;
  measurementSpec: ProcedureMeasurementSpec | null;
}

const FRESH_DRAFT: DraftStep = {
  kind: 'instruction',
  title: '',
  bodyMarkdown: '',
  safetyCritical: false,
  requiresPhoto: false,
  minPhotoCount: 0,
  measurementSpec: null,
};

export function ProcedureAuthoringRunner({
  assetInstanceId,
  devUserId,
  devOrgId,
  onClose,
}: {
  assetInstanceId: string;
  devUserId: string;
  devOrgId: string;
  onClose: () => void;
}) {
  const [bundle, setBundle] = useState<ProcedureBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftStep>(FRESH_DRAFT);
  const [pendingPhotos, setPendingPhotos] = useState<PhotoBuf[]>([]);
  const [measurementValue, setMeasurementValue] = useState<{
    numeric?: string;
    passFail?: 'pass' | 'fail';
    freeText?: string;
    overrideReason?: string;
  }>({});
  const [notes, setNotes] = useState('');
  const [stepEnteredAt, setStepEnteredAt] = useState<Date>(new Date());
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalTitle, setFinalTitle] = useState('');
  const [scopeInstanceOnly, setScopeInstanceOnly] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Body-scroll lock while overlay is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Start the authoring run on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await startFieldProcedure({
          assetInstanceId,
          devUserId,
          devOrgId,
        });
        if (!cancelled) setBundle(b);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetInstanceId]);

  function resetForNextStep() {
    setDraft(FRESH_DRAFT);
    setPendingPhotos([]);
    setMeasurementValue({});
    setNotes('');
    setStepEnteredAt(new Date());
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !bundle) return;
    // For the authoring runner, we need a step to upload against. The
    // photo endpoint is bound to a stepId, so we add the step server-side
    // first if no current step exists yet.
    setBusy(true);
    setError(null);
    try {
      // Photos are captured against the in-progress step. We add the
      // step server-side lazily on first photo so the upload endpoint
      // has a stepId. If the user changes step kind/title/etc. before
      // saving, we patch on Save (TODO v2 — for v1, force them to set
      // metadata before adding the first photo).
      if (!draft.title.trim()) {
        setError('Set the step title before capturing a photo.');
        setBusy(false);
        return;
      }
      // For v1 simplicity: photos are queued client-side and uploaded
      // when the step is saved. Avoids the server-roundtrip-per-photo
      // and keeps the create-step flow atomic.
      // We pre-upload to the storage anyway by creating a temp step,
      // BUT that's complex — easier: skip pre-upload, only upload at save time.
      // For now, just store the file as a local Object URL preview;
      // upload happens in onSaveStep.
      const url = URL.createObjectURL(file);
      // Stuff the File into a side ref keyed off the buf so save-time
      // can find it. Simple approach: keep a parallel array of File.
      pendingFiles.current.push(file);
      setPendingPhotos((prev) => [
        ...prev,
        { key: `pending-${Date.now()}-${pendingFiles.current.length}`, mime: file.type, url },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const pendingFiles = useRef<File[]>([]);

  function removePending(idx: number) {
    setPendingPhotos((prev) => prev.filter((_, i) => i !== idx));
    pendingFiles.current.splice(idx, 1);
  }

  async function onSaveStep() {
    if (!bundle) return;
    setError(null);
    if (!draft.title.trim()) {
      setError('Step title is required.');
      return;
    }
    if (
      draft.kind === 'measurement_required' &&
      (!draft.measurementSpec || !draft.measurementSpec.label.trim())
    ) {
      setError('Measurement label is required.');
      return;
    }
    setBusy(true);
    try {
      // 1. Author the step server-side.
      const stepDto = await addAuthoringStep({
        runId: bundle.run.id,
        step: {
          kind: draft.kind,
          title: draft.title.trim(),
          bodyMarkdown: draft.bodyMarkdown.trim() || null,
          safetyCritical: draft.safetyCritical,
          requiresPhoto: draft.kind === 'photo_required' || draft.requiresPhoto,
          minPhotoCount:
            draft.kind === 'photo_required'
              ? Math.max(1, draft.minPhotoCount)
              : draft.minPhotoCount,
          measurementSpec:
            draft.kind === 'measurement_required' ? draft.measurementSpec : null,
        },
        devUserId,
        devOrgId,
      });

      // 2. Upload any captured photos against the new step.
      const uploadedPhotos: Array<{ key: string; mime: string }> = [];
      for (const file of pendingFiles.current) {
        const result = await uploadProcedureStepPhoto({
          runId: bundle.run.id,
          stepId: stepDto.id,
          file,
          devUserId,
          devOrgId,
        });
        uploadedPhotos.push({ key: result.key, mime: result.mime });
      }

      // 3. Record evidence as a completion (this also marks the step
      //    "done" from the runner's perspective — finish gate looks for
      //    a completion per step at the end).
      const measurement = buildMeasurementForPayload(draft.measurementSpec);
      const payload: StepCompletionPayload = {
        outcome: 'completed',
        photos: uploadedPhotos,
        measurement,
        notes: notes.trim() || undefined,
        enteredAt: stepEnteredAt.toISOString(),
      };
      const completion = await patchProcedureStep({
        runId: bundle.run.id,
        stepId: stepDto.id,
        payload,
        devUserId,
        devOrgId,
      });

      // 4. Update local state with both the new step + completion.
      setBundle((prev) =>
        prev
          ? {
              ...prev,
              steps: [...prev.steps, stepDto],
              completions: [...prev.completions, completion],
            }
          : prev,
      );
      pendingFiles.current = [];
      resetForNextStep();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function buildMeasurementForPayload(
    spec: ProcedureMeasurementSpec | null,
  ): StepCompletionPayload extends infer T
    ? T extends { measurement?: infer M }
      ? M
      : never
    : never {
    if (!spec) return null as any;
    if (spec.kind === 'numeric') {
      const raw = measurementValue.numeric;
      if (raw == null || raw === '') return null as any;
      const value = Number(raw);
      if (Number.isNaN(value)) return null as any;
      return {
        kind: 'numeric',
        value,
        ...(measurementValue.overrideReason
          ? { overrideReason: measurementValue.overrideReason }
          : {}),
      } as any;
    }
    if (spec.kind === 'pass_fail') {
      if (!measurementValue.passFail) return null as any;
      return { kind: 'pass_fail', value: measurementValue.passFail } as any;
    }
    if (spec.kind === 'free_text') {
      if (!measurementValue.freeText) return null as any;
      return { kind: 'free_text', value: measurementValue.freeText } as any;
    }
    return null as any;
  }

  async function onConfirmFinalize() {
    if (!bundle) return;
    setError(null);
    if (!finalTitle.trim()) {
      setError('Procedure title is required.');
      return;
    }
    if (bundle.steps.length === 0) {
      setError('Add at least one step before finishing.');
      return;
    }
    setBusy(true);
    try {
      await finalizeAuthoring({
        runId: bundle.run.id,
        title: finalTitle.trim(),
        scopeAssetInstanceOnly: scopeInstanceOnly,
        linkedPartIds: [], // v1: no part linking from PWA; admin can add later.
        devUserId,
        devOrgId,
      });
      await finishProcedureRun(bundle.run.id, devUserId, devOrgId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!bundle) {
      onClose();
      return;
    }
    if (
      !confirm(
        bundle.steps.length > 0
          ? `Cancel and discard ${bundle.steps.length} captured step${bundle.steps.length === 1 ? '' : 's'}?`
          : 'Cancel and discard this draft procedure?',
      )
    ) {
      return;
    }
    try {
      await abandonProcedureRun({
        runId: bundle.run.id,
        reason: 'Cancelled by tech',
        devUserId,
        devOrgId,
      });
    } catch {
      // ignore — closing is more important than logging the abandon.
    }
    onClose();
  }

  if (error && !bundle) {
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
            <h2 className="truncate text-base font-semibold">Couldn't start authoring</h2>
          </div>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-signal-fault">{error}</p>
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Back
          </button>
        </div>
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
            <h2 className="truncate text-base font-semibold">Starting authoring…</h2>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-tertiary">
          Initializing…
        </div>
      </div>
    );
  }

  const stepNum = bundle.steps.length + 1;

  return (
    <div className="doc-overlay" role="dialog" aria-modal="true" aria-label="Document a procedure">
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onCancel}
          className="app-topbar-btn"
          aria-label="Cancel"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="inline-flex items-center gap-1.5 caption">
            <ListChecks size={12} strokeWidth={1.75} />
            DOCUMENT NEW PROCEDURE
            <span className="ml-1 normal-case text-ink-tertiary">
              · field capture
            </span>
          </span>
          <h2 className="truncate text-base font-semibold">
            Step {String(stepNum).padStart(2, '0')} — {draft.title || 'untitled'}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setFinalizeOpen(true)}
          className="btn btn-primary btn-sm"
          disabled={busy || bundle.steps.length === 0}
        >
          <Check size={14} strokeWidth={2} /> Finish
        </button>
      </header>

      <div className="doc-overlay-scroll">
        {error && (
          <div className="mx-auto mt-3 max-w-3xl rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
            {error}
          </div>
        )}

        {bundle.steps.length > 0 && (
          <div className="mx-auto mt-4 max-w-3xl rounded-md border border-signal-ok/30 bg-signal-ok/5 p-3 text-sm">
            <p className="font-medium text-signal-ok">
              {bundle.steps.length} step{bundle.steps.length === 1 ? '' : 's'} captured
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-ink-secondary">
              {bundle.steps.map((s, i) => (
                <li key={s.id} className="flex items-baseline gap-2">
                  <span className="font-mono tabular-nums text-xs text-ink-tertiary">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
          <h3 className="text-base font-semibold text-ink-primary">
            Capture step {stepNum}
          </h3>

          <label className="flex flex-col gap-1.5">
            <span className="caption">STEP TITLE</span>
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Apply LOTO"
              className="rounded border border-line bg-surface-raised p-3 text-sm"
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="caption">KIND</span>
            <select
              value={draft.kind}
              onChange={(e) => {
                const next = e.target.value as ProcedureStepKind;
                setDraft((prev) => ({
                  ...prev,
                  kind: next,
                  requiresPhoto: next === 'photo_required' ? true : prev.requiresPhoto,
                  minPhotoCount:
                    next === 'photo_required' ? Math.max(1, prev.minPhotoCount) : prev.minPhotoCount,
                  measurementSpec:
                    next === 'measurement_required'
                      ? prev.measurementSpec ?? { kind: 'numeric', label: '', unit: '' }
                      : null,
                  safetyCritical: next === 'safety_check' ? true : prev.safetyCritical,
                }));
              }}
              className="rounded border border-line bg-surface-raised p-3 text-sm"
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="caption">DETAILS (OPTIONAL)</span>
            <textarea
              value={draft.bodyMarkdown}
              onChange={(e) => setDraft({ ...draft, bodyMarkdown: e.target.value })}
              rows={3}
              placeholder="Brief description of what to do here. Markdown supported."
              className="rounded border border-line bg-surface-raised p-3 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.safetyCritical}
              onChange={(e) => setDraft({ ...draft, safetyCritical: e.target.checked })}
            />
            <span>
              <strong>Safety-critical</strong> — surfaces a banner; skipping
              requires written justification.
            </span>
          </label>

          {(draft.kind === 'photo_required' || draft.kind === 'measurement_required') && (
            <PhotoCapture
              minCount={draft.kind === 'photo_required' ? Math.max(1, draft.minPhotoCount) : 0}
              pending={pendingPhotos}
              onAdd={() => fileInputRef.current?.click()}
              onRemove={removePending}
              busy={busy}
            />
          )}

          {draft.kind === 'measurement_required' && draft.measurementSpec && (
            <MeasurementSpecAuthoring
              spec={draft.measurementSpec}
              onChange={(s) => setDraft({ ...draft, measurementSpec: s })}
              value={measurementValue}
              onValueChange={setMeasurementValue}
            />
          )}

          <label className="flex flex-col gap-1.5">
            <span className="caption">NOTES (OPTIONAL)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Anything tricky about this step?"
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
          onClick={onCancel}
          className="btn btn-ghost"
          disabled={busy}
        >
          Cancel
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSaveStep}
            className="btn btn-primary"
            disabled={busy || !draft.title.trim()}
          >
            <Plus size={16} strokeWidth={2} /> Save & next step
          </button>
        </div>
      </footer>

      {finalizeOpen && (
        <FinalizeDialog
          stepCount={bundle.steps.length}
          title={finalTitle}
          scopeInstanceOnly={scopeInstanceOnly}
          onChangeTitle={setFinalTitle}
          onChangeScope={setScopeInstanceOnly}
          onCancel={() => setFinalizeOpen(false)}
          onConfirm={onConfirmFinalize}
          busy={busy}
        />
      )}
    </div>
  );
}

function PhotoCapture({
  minCount,
  pending,
  onAdd,
  onRemove,
  busy,
}: {
  minCount: number;
  pending: PhotoBuf[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  busy: boolean;
}) {
  return (
    <section className="rounded-md border border-line bg-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="caption">
          PHOTO EVIDENCE
          {minCount > 0 && (
            <span className="ml-2 normal-case text-ink-tertiary">
              {pending.length >= minCount
                ? `OK (${pending.length} captured)`
                : `${minCount - pending.length} required`}
            </span>
          )}
        </span>
        <button type="button" onClick={onAdd} className="btn btn-secondary btn-sm" disabled={busy}>
          <Camera size={14} strokeWidth={2} /> Add photo
        </button>
      </div>
      {pending.length === 0 ? (
        <p className="text-sm text-ink-tertiary">No photos yet — tap Add photo.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {pending.map((p, i) => (
            <li
              key={i}
              className="relative aspect-square overflow-hidden rounded border border-line-subtle"
            >
              <img src={p.url} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white"
                aria-label="Remove photo"
              >
                <Trash2 size={12} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MeasurementSpecAuthoring({
  spec,
  onChange,
  value,
  onValueChange,
}: {
  spec: ProcedureMeasurementSpec;
  onChange: (s: ProcedureMeasurementSpec) => void;
  value: { numeric?: string; passFail?: 'pass' | 'fail'; freeText?: string };
  onValueChange: (v: typeof value) => void;
}) {
  return (
    <section className="rounded-md border border-line bg-surface-raised p-4">
      <span className="caption">MEASUREMENT SPEC + VALUE</span>
      <div className="mt-2 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="caption">TYPE</span>
          <select
            value={spec.kind}
            onChange={(e) => {
              const k = e.target.value as ProcedureMeasurementSpec['kind'];
              if (k === 'numeric') onChange({ kind: 'numeric', label: spec.label, unit: '' });
              else if (k === 'pass_fail') onChange({ kind: 'pass_fail', label: spec.label });
              else onChange({ kind: 'free_text', label: spec.label });
            }}
            className="rounded border border-line bg-surface-raised p-3 text-sm"
          >
            <option value="numeric">Numeric</option>
            <option value="pass_fail">Pass / fail</option>
            <option value="free_text">Free text</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="caption">LABEL</span>
          <input
            type="text"
            value={spec.label}
            onChange={(e) => onChange({ ...spec, label: e.target.value })}
            placeholder="Torque"
            className="rounded border border-line bg-surface-raised p-3 text-sm"
          />
        </label>
        {spec.kind === 'numeric' && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="caption">UNIT</span>
              <input
                type="text"
                value={spec.unit}
                onChange={(e) => onChange({ ...spec, unit: e.target.value })}
                placeholder="N·m"
                className="rounded border border-line bg-surface-raised p-3 text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="caption">MIN</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={spec.min ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...spec,
                      min: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="rounded border border-line bg-surface-raised p-3 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="caption">MAX</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={spec.max ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...spec,
                      max: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className="rounded border border-line bg-surface-raised p-3 text-sm"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="caption">VALUE YOU MEASURED</span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={value.numeric ?? ''}
                onChange={(e) => onValueChange({ ...value, numeric: e.target.value })}
                placeholder="—"
                className="rounded border border-line bg-surface-raised p-3 text-sm font-mono tabular-nums"
              />
            </label>
          </>
        )}
        {spec.kind === 'pass_fail' && (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onValueChange({ ...value, passFail: 'pass' })}
              className={`btn ${value.passFail === 'pass' ? 'btn-primary' : 'btn-secondary'}`}
            >
              <Check size={16} strokeWidth={2} /> Pass
            </button>
            <button
              type="button"
              onClick={() => onValueChange({ ...value, passFail: 'fail' })}
              className={`btn ${value.passFail === 'fail' ? 'btn-danger' : 'btn-secondary'}`}
            >
              <X size={16} strokeWidth={2} /> Fail
            </button>
          </div>
        )}
        {spec.kind === 'free_text' && (
          <label className="flex flex-col gap-1.5">
            <span className="caption">VALUE YOU OBSERVED</span>
            <textarea
              value={value.freeText ?? ''}
              onChange={(e) => onValueChange({ ...value, freeText: e.target.value })}
              rows={2}
              className="rounded border border-line bg-surface-raised p-3 text-sm"
            />
          </label>
        )}
      </div>
    </section>
  );
}

function FinalizeDialog({
  stepCount,
  title,
  scopeInstanceOnly,
  onChangeTitle,
  onChangeScope,
  onCancel,
  onConfirm,
  busy,
}: {
  stepCount: number;
  title: string;
  scopeInstanceOnly: boolean;
  onChangeTitle: (s: string) => void;
  onChangeScope: (b: boolean) => void;
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
        <h3 className="text-base font-semibold text-ink-primary">Finish procedure</h3>
        <p className="mt-1 text-xs text-ink-tertiary">
          {stepCount} step{stepCount === 1 ? '' : 's'} captured.
        </p>
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="caption">PROCEDURE TITLE</span>
          <input
            type="text"
            value={title}
            onChange={(e) => onChangeTitle(e.target.value)}
            placeholder="Replace bearing assembly"
            className="form-input"
            autoFocus
          />
        </label>
        <fieldset className="mt-4 flex flex-col gap-2 rounded border border-line p-3">
          <legend className="caption px-1">SCOPE</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              checked={!scopeInstanceOnly}
              onChange={() => onChangeScope(false)}
            />
            <span>Applies to all units of this asset model (recommended)</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              checked={scopeInstanceOnly}
              onChange={() => onChangeScope(true)}
            />
            <span>This unit only — for a serial-specific quirk</span>
          </label>
        </fieldset>
        <p className="mt-3 text-xs text-ink-tertiary">
          Other techs will see this procedure right away with an{' '}
          <strong>UNVERIFIED</strong> chip until an admin reviews it.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn btn-ghost" disabled={busy}>
            Back
          </button>
          <button type="button" onClick={onConfirm} className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save procedure'}
          </button>
        </div>
      </div>
    </div>
  );
}
