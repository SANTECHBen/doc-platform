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
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  Copy,
  ListChecks,
  Pencil,
  Plus,
  Ruler,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import {
  abandonProcedureRun,
  addAuthoringStep,
  cloneFromTemplate,
  finalizeAuthoring,
  finishProcedureRun,
  listProcedureTemplates,
  patchProcedureStep,
  reorderAuthoringSteps,
  startFieldProcedure,
  updateAuthoringStep,
  uploadProcedureStepPhoto,
  type ProcedureBundle,
  type ProcedureMeasurementSpec,
  type ProcedureStepDto,
  type ProcedureStepKind,
  type ProcedureTemplateDto,
  type StepCompletionPayload,
} from '@/lib/api';
import { MicButton } from '@/components/voice-input';

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
  // Procedure-level title — editable at the top of the authoring runner;
  // carried into the Finalize dialog so the tech doesn't retype.
  const [procedureTitle, setProcedureTitle] = useState('Untitled procedure');
  const [draft, setDraft] = useState<DraftStep>(FRESH_DRAFT);
  // When set, the editor is editing an existing saved step rather than
  // composing a new one. Save calls PATCH instead of POST.
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
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
  const [scopeInstanceOnly, setScopeInstanceOnly] = useState(false);
  // Template offerings — fetched lazily once the run is created. Surfaced
  // as a one-tap "use existing procedure as template" affordance only
  // before the tech captures their first step.
  const [templates, setTemplates] = useState<ProcedureTemplateDto[] | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Body-scroll lock while overlay is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Start the authoring run on mount + fetch templates in parallel so
  // the "use existing procedure as template" affordance is immediately
  // tappable when the runner opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, tpls] = await Promise.all([
          startFieldProcedure({
            assetInstanceId,
            devUserId,
            devOrgId,
          }),
          listProcedureTemplates({
            assetInstanceId,
            devUserId,
            devOrgId,
          }).catch(() => [] as ProcedureTemplateDto[]),
        ]);
        if (!cancelled) {
          setBundle(b);
          setTemplates(tpls);
        }
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
      const stepInput = {
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
      };

      // EDIT path — PATCH the existing step. We don't re-upload photos
      // here; evidence editing is its own feature (v3). For now editing
      // a saved step changes its authoring metadata only.
      if (editingStepId) {
        const stepDto = await updateAuthoringStep({
          runId: bundle.run.id,
          stepId: editingStepId,
          step: stepInput,
          devUserId,
          devOrgId,
        });
        setBundle((prev) =>
          prev
            ? {
                ...prev,
                steps: prev.steps.map((s) => (s.id === stepDto.id ? stepDto : s)),
              }
            : prev,
        );
        setEditingStepId(null);
        resetForNextStep();
        return;
      }

      // CREATE path — POST a new step + upload photos + record completion.
      const stepDto = await addAuthoringStep({
        runId: bundle.run.id,
        step: stepInput,
        devUserId,
        devOrgId,
      });

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

  // Load an existing saved step into the editor for in-place edit. The
  // tech can change kind/title/body/evidence-requirements/measurement-
  // spec; current implementation doesn't re-edit captured evidence.
  function onEditStep(stepId: string) {
    if (!bundle) return;
    const step = bundle.steps.find((s) => s.id === stepId);
    if (!step) return;
    setEditingStepId(stepId);
    setDraft({
      kind: step.kind,
      title: step.title,
      bodyMarkdown: step.bodyMarkdown ?? '',
      safetyCritical: step.safetyCritical,
      requiresPhoto: step.requiresPhoto,
      minPhotoCount: step.minPhotoCount,
      measurementSpec: step.measurementSpec ?? null,
    });
    setPendingPhotos([]);
    pendingFiles.current = [];
    setMeasurementValue({});
    setNotes('');
  }

  function onCancelEdit() {
    setEditingStepId(null);
    resetForNextStep();
  }

  // Move a saved step up or down in the captured-list. Server reorders
  // via re-stamping orderingHint; we mirror locally so the UI updates
  // immediately without a refetch.
  async function onMoveStep(stepId: string, dir: -1 | 1) {
    if (!bundle) return;
    const idx = bundle.steps.findIndex((s) => s.id === stepId);
    const swapWith = idx + dir;
    if (idx < 0 || swapWith < 0 || swapWith >= bundle.steps.length) return;
    const next = [...bundle.steps];
    const tmp = next[idx]!;
    next[idx] = next[swapWith]!;
    next[swapWith] = tmp;
    setBundle((prev) => (prev ? { ...prev, steps: next } : prev));
    try {
      await reorderAuthoringSteps({
        runId: bundle.run.id,
        orderedStepIds: next.map((s) => s.id),
        devUserId,
        devOrgId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Revert on failure so client + server stay in sync.
      setBundle((prev) => (prev ? { ...prev, steps: bundle.steps } : prev));
    }
  }

  // One-tap clone: pull every step from a previously-completed
  // procedure on this asset model into the new run. Tech then walks
  // through and captures fresh evidence per step.
  async function onUseTemplate(templateDocId: string) {
    if (!bundle) return;
    setError(null);
    setBusy(true);
    try {
      const result = await cloneFromTemplate({
        runId: bundle.run.id,
        templateDocId,
        devUserId,
        devOrgId,
      });
      setBundle((prev) =>
        prev ? { ...prev, steps: result.steps } : prev,
      );
      // Pre-fill the procedure title from the template if the tech
      // hasn't typed one yet.
      const tpl = templates?.find((t) => t.documentId === templateDocId);
      if (tpl && procedureTitle === 'Untitled procedure') {
        setProcedureTitle(tpl.title);
      }
      setTemplatePickerOpen(false);
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
    const trimmedTitle = procedureTitle.trim();
    if (!trimmedTitle || trimmedTitle === 'Untitled procedure') {
      setError('Give the procedure a real title before finishing.');
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
        title: trimmedTitle,
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

        {/* Procedure-level title — editable at top, carried into Finalize. */}
        <div className="mx-auto mt-4 flex max-w-3xl flex-col gap-1.5 px-4">
          <span className="caption">PROCEDURE TITLE</span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={procedureTitle}
              onChange={(e) => setProcedureTitle(e.target.value)}
              onFocus={(e) => {
                if (procedureTitle === 'Untitled procedure') e.currentTarget.select();
              }}
              placeholder="Replace bearing assembly"
              className="flex-1 rounded border border-line bg-surface-raised p-3 text-base font-medium"
            />
            <MicButton
              size="md"
              appendMode={false}
              onTranscript={(t) => setProcedureTitle(t)}
            />
          </div>
        </div>

        {bundle.steps.length === 0 && templates && templates.length > 0 && (
          <div className="mx-auto mt-4 flex max-w-3xl items-center justify-between gap-3 rounded-md border border-brand/30 bg-brand-soft-v/10 px-4 py-3 text-sm">
            <div className="flex items-start gap-3">
              <Copy size={16} strokeWidth={1.75} className="mt-0.5 text-brand" />
              <div>
                <p className="font-medium text-brand">Reuse an existing procedure</p>
                <p className="text-ink-secondary">
                  Clone the steps from a previous procedure on this asset
                  model and capture fresh evidence per step.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setTemplatePickerOpen(true)}
              className="btn btn-secondary btn-sm shrink-0"
              disabled={busy}
            >
              Browse {templates.length}
            </button>
          </div>
        )}

        {bundle.steps.length > 0 && (
          <div className="mx-auto mt-4 max-w-3xl rounded-md border border-signal-ok/30 bg-signal-ok/5 p-3 text-sm">
            <p className="mb-2 font-medium text-signal-ok">
              {bundle.steps.length} step{bundle.steps.length === 1 ? '' : 's'} captured
            </p>
            <ul className="flex flex-col gap-1.5">
              {bundle.steps.map((s, i) => (
                <li
                  key={s.id}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 ${
                    editingStepId === s.id ? 'bg-brand-soft-v/15' : ''
                  }`}
                >
                  <span className="font-mono tabular-nums text-xs text-ink-tertiary shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-ink-secondary">
                    {s.title}
                  </span>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onMoveStep(s.id, -1)}
                      disabled={busy || i === 0}
                      className="rounded p-1 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
                      aria-label="Move up"
                    >
                      <ChevronUp size={14} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMoveStep(s.id, 1)}
                      disabled={busy || i === bundle.steps.length - 1}
                      className="rounded p-1 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
                      aria-label="Move down"
                    >
                      <ChevronDown size={14} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditStep(s.id)}
                      disabled={busy || editingStepId === s.id}
                      className="rounded p-1 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
                      aria-label="Edit step"
                    >
                      <Pencil size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
          <h3 className="text-base font-semibold text-ink-primary">
            {editingStepId
              ? `Edit step ${bundle.steps.findIndex((s) => s.id === editingStepId) + 1}`
              : `Capture step ${stepNum}`}
          </h3>

          <label className="flex flex-col gap-1.5">
            <span className="caption">STEP TITLE</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Apply LOTO"
                className="flex-1 rounded border border-line bg-surface-raised p-3 text-sm"
                autoFocus
              />
              <MicButton
                size="md"
                appendMode={false}
                onTranscript={(t) => setDraft((prev) => ({ ...prev, title: t }))}
              />
            </div>
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
            <div className="flex items-start gap-2">
              <textarea
                value={draft.bodyMarkdown}
                onChange={(e) => setDraft({ ...draft, bodyMarkdown: e.target.value })}
                rows={3}
                placeholder="Brief description of what to do here. Markdown supported."
                className="flex-1 rounded border border-line bg-surface-raised p-3 text-sm"
              />
              <MicButton
                size="md"
                appendMode
                onTranscript={(t) =>
                  setDraft((prev) => ({
                    ...prev,
                    bodyMarkdown: prev.bodyMarkdown
                      ? prev.bodyMarkdown + ' ' + t
                      : t,
                  }))
                }
              />
            </div>
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
        {editingStepId ? (
          <button
            type="button"
            onClick={onCancelEdit}
            className="btn btn-ghost"
            disabled={busy}
          >
            Cancel edit
          </button>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost"
            disabled={busy}
          >
            Cancel
          </button>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSaveStep}
            className="btn btn-primary"
            disabled={busy || !draft.title.trim()}
          >
            {editingStepId ? (
              <>
                <Check size={16} strokeWidth={2} /> Save changes
              </>
            ) : (
              <>
                <Plus size={16} strokeWidth={2} /> Save &amp; next step
              </>
            )}
          </button>
        </div>
      </footer>

      {finalizeOpen && (
        <FinalizeDialog
          stepCount={bundle.steps.length}
          title={procedureTitle}
          scopeInstanceOnly={scopeInstanceOnly}
          onChangeTitle={setProcedureTitle}
          onChangeScope={setScopeInstanceOnly}
          onCancel={() => setFinalizeOpen(false)}
          onConfirm={onConfirmFinalize}
          busy={busy}
        />
      )}
      {templatePickerOpen && (
        <TemplatePicker
          templates={templates ?? []}
          onCancel={() => setTemplatePickerOpen(false)}
          onPick={onUseTemplate}
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

function TemplatePicker({
  templates,
  onCancel,
  onPick,
  busy,
}: {
  templates: ProcedureTemplateDto[];
  onCancel: () => void;
  onPick: (templateDocId: string) => void;
  busy: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="flex w-full max-w-md flex-col rounded-md border border-line bg-surface-raised p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-ink-primary">
              Use existing procedure as template
            </h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              The step structure copies in; you capture fresh evidence per
              step.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-ink-tertiary hover:bg-surface hover:text-ink-primary"
            aria-label="Close"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {templates.length === 0 && (
            <li className="rounded border border-dashed border-line bg-surface p-4 text-center text-sm text-ink-tertiary">
              No procedures on this asset model yet.
            </li>
          )}
          {templates.map((t) => (
            <li key={t.documentId}>
              <button
                type="button"
                onClick={() => onPick(t.documentId)}
                disabled={busy}
                className="surface-etched flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:opacity-50"
              >
                <ListChecks size={16} strokeWidth={1.75} className="shrink-0 text-ink-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-primary">
                    {t.title}
                  </p>
                  <p className="font-mono text-[11px] text-ink-tertiary">
                    {t.stepCount} step{t.stepCount === 1 ? '' : 's'}
                    {t.source === 'field' && t.capturedByDisplayName
                      ? ` · captured by ${t.capturedByDisplayName}`
                      : t.source === 'oem'
                        ? ' · OEM'
                        : ''}
                    {t.source === 'field' && !t.verified ? ' · unverified' : ''}
                  </p>
                </div>
                <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-ink-tertiary" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
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
