'use client';

// ProcedureDocAuthoring — full doc-authoring editor for field-authored
// procedures. The author (engineer or technician) writes a polished
// reference procedure with consistent template sections: Title, Tools
// Required, Safety (optional toggle), Steps (with media + substeps),
// Verification (optional toggle).
//
// This is *authoring-first*: the output is a runnable + readable doc.
// Distinct from the capture-as-you-go runner (which records evidence
// of doing the work). Both write into the same procedure_steps schema.

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ClipboardCheck,
  ListChecks,
  Pencil,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import {
  abandonProcedureRun,
  addAuthoringStep,
  completeAuthoring,
  finalizeAuthoring,
  getProcedureDoc,
  patchProcedureMetadata,
  reorderAuthoringSteps,
  startFieldProcedure,
  updateAuthoringStep,
  uploadStepMedia,
  type ProcedureBundle,
  type ProcedureDocFullDto,
  type ProcedureDocMetadata,
  type ProcedureStepDto,
  type ProcedureStepKind,
  type ProcedureStepMedia,
} from '@/lib/api';
import { MicButton } from '@/components/voice-input';

// Step "kind" controls run-time enforcement, NOT what's attached to the
// authored step. Photos/videos (authored content) are added in the MEDIA
// section below regardless of kind.
//
//   instruction          → tech reads + taps Done
//   safety_check         → tech acknowledges; runner shows safety banner
//   photo_required       → runner blocks Done until tech captures evidence photo
//   measurement_required → runner blocks Done until tech enters a value
const KIND_OPTIONS: Array<{ value: ProcedureStepKind; label: string }> = [
  { value: 'instruction', label: 'Instruction (read & tap)' },
  { value: 'safety_check', label: 'Safety acknowledgement' },
  { value: 'photo_required', label: 'Run-time photo evidence required' },
  { value: 'measurement_required', label: 'Run-time measurement required' },
];

interface LocalSubstep {
  id?: string;
  title: string;
  bodyMarkdown: string;
}

interface LocalStep {
  // null until first save → tells onSaveStep whether to POST or PATCH.
  id: string | null;
  kind: ProcedureStepKind;
  title: string;
  bodyMarkdown: string;
  safetyCritical: boolean;
  requiresPhoto: boolean;
  minPhotoCount: number;
  // Authored media — photos and (optional) video. Set-replace on save.
  media: ProcedureStepMedia[];
  // Substeps — simple {title, body} pairs. Server regenerates IDs each
  // save (set-replace).
  substeps: LocalSubstep[];
  // Edit-mode toggle: collapsed by default once saved; expanded for new
  // unsaved steps.
  editing: boolean;
  // Set true when the local content differs from what's on the server.
  // Drives the per-step "Save changes" indicator.
  dirty: boolean;
}

function freshLocalStep(): LocalStep {
  return {
    id: null,
    kind: 'instruction',
    title: '',
    bodyMarkdown: '',
    safetyCritical: false,
    requiresPhoto: false,
    minPhotoCount: 0,
    media: [],
    substeps: [],
    editing: true,
    dirty: true,
  };
}

function dtoToLocal(s: ProcedureStepDto & {
  media?: ProcedureStepMedia[];
  substeps?: Array<{ id?: string; title: string; bodyMarkdown: string | null }>;
}): LocalStep {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    bodyMarkdown: s.bodyMarkdown ?? '',
    safetyCritical: s.safetyCritical,
    requiresPhoto: s.requiresPhoto,
    minPhotoCount: s.minPhotoCount,
    media: s.media ?? [],
    substeps: (s.substeps ?? []).map((ss) => ({
      id: ss.id,
      title: ss.title,
      bodyMarkdown: ss.bodyMarkdown ?? '',
    })),
    editing: false,
    dirty: false,
  };
}

const FRESH_METADATA: ProcedureDocMetadata = {
  toolsRequired: [],
  safety: { enabled: false, notes: null },
  verification: { enabled: false, notes: null },
};

export function ProcedureDocAuthoring({
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
  const [procedureTitle, setProcedureTitle] = useState('Untitled procedure');
  const [metadata, setMetadata] = useState<ProcedureDocMetadata>(FRESH_METADATA);
  const [toolDraft, setToolDraft] = useState('');
  const [steps, setSteps] = useState<LocalStep[]>([]);

  // Lock body scroll while overlay is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Start the run + fetch the procedure tree (covers resume case).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await startFieldProcedure({
          assetInstanceId,
          devUserId,
          devOrgId,
        });
        if (cancelled) return;
        setBundle(b);
        if (b.document.title && b.document.title !== 'Untitled procedure') {
          setProcedureTitle(b.document.title);
        }
        // Fetch full doc tree (steps + media + substeps + metadata) so
        // a refresh resumes where the author left off.
        const full = await getProcedureDoc(b.document.id, devUserId, devOrgId);
        if (cancelled) return;
        if (full.metadata) setMetadata(full.metadata);
        if (full.steps.length > 0) {
          setSteps(full.steps.map(dtoToLocal));
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

  // ---- Tools editor ----
  function addTool() {
    const t = toolDraft.trim();
    if (!t) return;
    setMetadata({ ...metadata, toolsRequired: [...metadata.toolsRequired, t] });
    setToolDraft('');
  }
  function removeTool(idx: number) {
    setMetadata({
      ...metadata,
      toolsRequired: metadata.toolsRequired.filter((_, i) => i !== idx),
    });
  }

  // ---- Step add/edit/delete/move ----
  function addStep() {
    setSteps((prev) => [...prev, freshLocalStep()]);
  }
  function updateStep(idx: number, partial: Partial<LocalStep>) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...partial, dirty: true } : s)),
    );
  }
  function setStepEditing(idx: number, editing: boolean) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, editing } : s)));
  }
  function removeStep(idx: number) {
    const step = steps[idx];
    if (!step) return;
    if (step.id && !confirm('Remove this saved step? This cannot be undone.')) return;
    if (!step.id && step.title.trim() && !confirm('Discard this draft step?')) return;
    setSteps((prev) => prev.filter((_, i) => i !== idx));
    // TODO: server-side delete for already-saved steps. For v1 we keep
    // them server-side; this just hides locally. Add a delete endpoint
    // in v3.5 for full parity.
  }

  async function moveStep(idx: number, dir: -1 | 1) {
    if (!bundle) return;
    const next = idx + dir;
    if (next < 0 || next >= steps.length) return;
    const reordered = [...steps];
    const tmp = reordered[idx]!;
    reordered[idx] = reordered[next]!;
    reordered[next] = tmp;
    setSteps(reordered);
    // Persist server-side only when both rows are saved.
    const ids = reordered
      .filter((s): s is LocalStep & { id: string } => Boolean(s.id))
      .map((s) => s.id);
    if (ids.length === reordered.length) {
      try {
        await reorderAuthoringSteps({
          runId: bundle.run.id,
          orderedStepIds: ids,
          devUserId,
          devOrgId,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  // ---- Step media ----
  async function onAddMedia(stepIdx: number, file: File) {
    if (!bundle) return;
    const step = steps[stepIdx];
    if (!step) return;
    if (!step.title.trim()) {
      setError('Give the step a title before attaching media.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Auto-save the step on the first media attach so the upload
      // endpoint has a stable stepId. Subsequent attaches reuse the
      // existing id. This means a step with a title but no other content
      // gets persisted as soon as the user taps "Add photo / video."
      let stepId = step.id;
      if (!stepId) {
        const stepInput = {
          kind: step.kind,
          title: step.title.trim(),
          bodyMarkdown: step.bodyMarkdown.trim() || null,
          safetyCritical: step.safetyCritical || step.kind === 'safety_check',
          requiresPhoto: step.kind === 'photo_required' || step.requiresPhoto,
          minPhotoCount:
            step.kind === 'photo_required'
              ? Math.max(1, step.minPhotoCount)
              : step.minPhotoCount,
          measurementSpec: null,
          media: [] as ProcedureStepMedia[],
          substeps: step.substeps
            .filter((ss) => ss.title.trim())
            .map((ss) => ({
              title: ss.title.trim(),
              bodyMarkdown: ss.bodyMarkdown.trim() || null,
            })),
        };
        const created = await addAuthoringStep({
          runId: bundle.run.id,
          step: stepInput,
          devUserId,
          devOrgId,
        });
        stepId = created.id;
        // Mirror the server-assigned id into local state without losing
        // unsaved edits the user may have made between starting the
        // upload and now.
        setSteps((prev) =>
          prev.map((s, i) =>
            i === stepIdx
              ? { ...s, id: created.id }
              : s,
          ),
        );
      }
      const out = await uploadStepMedia({
        runId: bundle.run.id,
        stepId,
        file,
        devUserId,
        devOrgId,
      });
      const newMedia: ProcedureStepMedia = {
        kind: out.kind,
        storageKey: out.storageKey,
        mime: out.mime,
        url: out.url,
      };
      setSteps((prev) =>
        prev.map((s, i) =>
          i === stepIdx
            ? { ...s, media: [...s.media, newMedia], dirty: true }
            : s,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function removeMedia(stepIdx: number, mediaIdx: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIdx
          ? {
              ...s,
              media: s.media.filter((_, mi) => mi !== mediaIdx),
              dirty: true,
            }
          : s,
      ),
    );
  }

  // ---- Substeps ----
  function addSubstep(stepIdx: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIdx
          ? {
              ...s,
              substeps: [...s.substeps, { title: '', bodyMarkdown: '' }],
              dirty: true,
            }
          : s,
      ),
    );
  }
  function updateSubstep(
    stepIdx: number,
    subIdx: number,
    partial: Partial<LocalSubstep>,
  ) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIdx
          ? {
              ...s,
              substeps: s.substeps.map((ss, j) =>
                j === subIdx ? { ...ss, ...partial } : ss,
              ),
              dirty: true,
            }
          : s,
      ),
    );
  }
  function removeSubstep(stepIdx: number, subIdx: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIdx
          ? {
              ...s,
              substeps: s.substeps.filter((_, j) => j !== subIdx),
              dirty: true,
            }
          : s,
      ),
    );
  }

  // ---- Step save ----
  async function onSaveStep(idx: number) {
    if (!bundle) return;
    const step = steps[idx];
    if (!step) return;
    if (!step.title.trim()) {
      setError('Step title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const stepInput = {
        kind: step.kind,
        title: step.title.trim(),
        bodyMarkdown: step.bodyMarkdown.trim() || null,
        safetyCritical: step.safetyCritical || step.kind === 'safety_check',
        requiresPhoto: step.kind === 'photo_required' || step.requiresPhoto,
        minPhotoCount:
          step.kind === 'photo_required'
            ? Math.max(1, step.minPhotoCount)
            : step.minPhotoCount,
        measurementSpec: null,
        media: step.media.map((m) => ({
          kind: m.kind,
          storageKey: m.storageKey,
          mime: m.mime,
          ...(m.caption ? { caption: m.caption } : {}),
        })),
        substeps: step.substeps
          .filter((ss) => ss.title.trim())
          .map((ss) => ({
            title: ss.title.trim(),
            bodyMarkdown: ss.bodyMarkdown.trim() || null,
          })),
      };

      const dto = step.id
        ? await updateAuthoringStep({
            runId: bundle.run.id,
            stepId: step.id,
            step: stepInput,
            devUserId,
            devOrgId,
          })
        : await addAuthoringStep({
            runId: bundle.run.id,
            step: stepInput,
            devUserId,
            devOrgId,
          });

      setSteps((prev) =>
        prev.map((s, i) =>
          i === idx
            ? { ...dtoToLocal(dto), editing: false }
            : s,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- Save metadata + finish ----
  async function persistMetadataAndTitle() {
    if (!bundle) return;
    await patchProcedureMetadata({
      runId: bundle.run.id,
      metadata,
      devUserId,
      devOrgId,
    });
    await finalizeAuthoring({
      runId: bundle.run.id,
      title: procedureTitle.trim() || 'Untitled procedure',
      scopeAssetInstanceOnly: false,
      linkedPartIds: [],
      devUserId,
      devOrgId,
    });
  }

  async function onSaveDraft() {
    if (!bundle) return;
    setBusy(true);
    setError(null);
    try {
      await persistMetadataAndTitle();
      // Best-effort: persist any dirty in-edit steps that have a title.
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        if (s.dirty && s.title.trim()) {
          await onSaveStep(i);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFinish() {
    if (!bundle) return;
    setError(null);
    if (!procedureTitle.trim() || procedureTitle === 'Untitled procedure') {
      setError('Give the procedure a real title before finishing.');
      return;
    }
    if (steps.length === 0) {
      setError('Add at least one step before finishing.');
      return;
    }
    if (steps.some((s) => !s.id)) {
      setError('Save all steps before finishing.');
      return;
    }
    setBusy(true);
    try {
      await persistMetadataAndTitle();
      await completeAuthoring(bundle.run.id, devUserId, devOrgId);
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
    const hasContent =
      steps.length > 0 ||
      metadata.toolsRequired.length > 0 ||
      metadata.safety.enabled ||
      metadata.verification.enabled;
    if (
      hasContent &&
      !confirm('Discard this draft procedure? Saved changes will be lost.')
    ) {
      return;
    }
    try {
      await abandonProcedureRun({
        runId: bundle.run.id,
        reason: 'Cancelled by author',
        devUserId,
        devOrgId,
      });
    } catch {
      // ignore
    }
    onClose();
  }

  // ---- Render ----
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
            <h2 className="truncate text-base font-semibold">
              Couldn&apos;t start authoring
            </h2>
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
            <h2 className="truncate text-base font-semibold">Loading…</h2>
          </div>
        </header>
      </div>
    );
  }

  return (
    <div
      className="doc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Document a procedure"
    >
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
            DOCUMENT PROCEDURE
            <span className="ml-1 normal-case text-ink-tertiary">· field</span>
          </span>
          <h2 className="truncate text-base font-semibold">
            {procedureTitle || 'Untitled procedure'}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onSaveDraft}
            className="btn btn-ghost btn-sm"
            disabled={busy}
            title="Save draft"
          >
            <Save size={14} strokeWidth={2} /> Save
          </button>
          <button
            type="button"
            onClick={onFinish}
            className="btn btn-primary btn-sm"
            disabled={busy || steps.length === 0}
          >
            <Check size={14} strokeWidth={2} /> Finish
          </button>
        </div>
      </header>

      <div className="doc-overlay-scroll">
        {error && (
          <div className="mx-auto mt-3 max-w-3xl rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
            {error}
          </div>
        )}

        <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {/* TITLE */}
          <section className="flex flex-col gap-2">
            <span className="caption">PROCEDURE TITLE</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={procedureTitle}
                onChange={(e) => setProcedureTitle(e.target.value)}
                onFocus={(e) => {
                  if (procedureTitle === 'Untitled procedure')
                    e.currentTarget.select();
                }}
                placeholder="Replace bearing assembly"
                className="flex-1 rounded border border-line bg-surface-raised p-3 text-lg font-semibold"
              />
              <MicButton
                size="md"
                appendMode={false}
                onTranscript={(t) => setProcedureTitle(t)}
              />
            </div>
          </section>

          {/* TOOLS REQUIRED */}
          <section className="flex flex-col gap-2 rounded-md border border-line bg-surface-raised p-4">
            <div className="flex items-center justify-between">
              <span className="caption">TOOLS REQUIRED</span>
              <span className="text-xs text-ink-tertiary">
                {metadata.toolsRequired.length} listed
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={toolDraft}
                onChange={(e) => setToolDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTool();
                  }
                }}
                placeholder="Torque wrench (10–30 N·m)"
                className="flex-1 rounded border border-line bg-surface p-2 text-sm"
              />
              <button
                type="button"
                onClick={addTool}
                className="btn btn-secondary btn-sm"
                disabled={!toolDraft.trim()}
              >
                <Plus size={14} strokeWidth={2} /> Add
              </button>
            </div>
            {metadata.toolsRequired.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {metadata.toolsRequired.map((t, i) => (
                  <li
                    key={`${i}-${t}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-surface px-2.5 py-1 text-sm"
                  >
                    <span>{t}</span>
                    <button
                      type="button"
                      onClick={() => removeTool(i)}
                      className="text-ink-tertiary hover:text-signal-fault"
                      aria-label={`Remove ${t}`}
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* SAFETY (toggle) */}
          <ToggleSection
            label="SAFETY"
            iconColor="text-signal-safety"
            enabled={metadata.safety.enabled}
            onToggle={(b) =>
              setMetadata({
                ...metadata,
                safety: { ...metadata.safety, enabled: b },
              })
            }
            notes={metadata.safety.notes}
            onChangeNotes={(notes) =>
              setMetadata({
                ...metadata,
                safety: { ...metadata.safety, notes },
              })
            }
            placeholder="Lockout/tagout requirements, PPE, hazards to be aware of…"
          />

          {/* STEPS */}
          <section className="flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4">
            <div className="flex items-center justify-between">
              <span className="caption">STEPS</span>
              <span className="text-xs text-ink-tertiary">
                {steps.length} step{steps.length === 1 ? '' : 's'}
              </span>
            </div>
            {steps.length === 0 ? (
              <p className="rounded border border-dashed border-line bg-surface p-4 text-center text-sm text-ink-tertiary">
                No steps yet — tap &ldquo;Add step&rdquo; below.
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {steps.map((step, i) => (
                  <StepCard
                    key={step.id ?? `local-${i}`}
                    index={i}
                    total={steps.length}
                    step={step}
                    busy={busy}
                    onUpdate={(p) => updateStep(i, p)}
                    onSetEditing={(b) => setStepEditing(i, b)}
                    onSave={() => onSaveStep(i)}
                    onRemove={() => removeStep(i)}
                    onMove={(dir) => moveStep(i, dir)}
                    onAddMedia={(file) => onAddMedia(i, file)}
                    onRemoveMedia={(mi) => removeMedia(i, mi)}
                    onAddSubstep={() => addSubstep(i)}
                    onUpdateSubstep={(si, p) => updateSubstep(i, si, p)}
                    onRemoveSubstep={(si) => removeSubstep(i, si)}
                  />
                ))}
              </ol>
            )}
            <button
              type="button"
              onClick={addStep}
              className="btn btn-secondary self-start"
              disabled={busy}
            >
              <Plus size={14} strokeWidth={2} /> Add step
            </button>
          </section>

          {/* VERIFICATION (toggle) */}
          <ToggleSection
            label="VERIFICATION"
            iconColor="text-signal-ok"
            enabled={metadata.verification.enabled}
            onToggle={(b) =>
              setMetadata({
                ...metadata,
                verification: { ...metadata.verification, enabled: b },
              })
            }
            notes={metadata.verification.notes}
            onChangeNotes={(notes) =>
              setMetadata({
                ...metadata,
                verification: { ...metadata.verification, notes },
              })
            }
            placeholder="How to confirm the procedure was performed correctly. Functional test, measurements, sign-off…"
          />
        </main>
      </div>
    </div>
  );
}

function ToggleSection({
  label,
  iconColor,
  enabled,
  onToggle,
  notes,
  onChangeNotes,
  placeholder,
}: {
  label: string;
  iconColor: string;
  enabled: boolean;
  onToggle: (b: boolean) => void;
  notes: string | null;
  onChangeNotes: (notes: string | null) => void;
  placeholder: string;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-line bg-surface-raised p-4">
      <label className="flex cursor-pointer items-center justify-between">
        <span className={`caption ${iconColor}`}>{label}</span>
        <span className="flex items-center gap-2 text-xs text-ink-secondary">
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4"
          />
        </span>
      </label>
      {enabled && (
        <div className="flex items-start gap-2">
          <textarea
            value={notes ?? ''}
            onChange={(e) => onChangeNotes(e.target.value || null)}
            placeholder={placeholder}
            rows={3}
            className="flex-1 rounded border border-line bg-surface p-3 text-sm"
          />
          <MicButton
            size="md"
            appendMode
            onTranscript={(t) =>
              onChangeNotes(notes ? notes + ' ' + t : t)
            }
          />
        </div>
      )}
    </section>
  );
}

function StepCard({
  index,
  total,
  step,
  busy,
  onUpdate,
  onSetEditing,
  onSave,
  onRemove,
  onMove,
  onAddMedia,
  onRemoveMedia,
  onAddSubstep,
  onUpdateSubstep,
  onRemoveSubstep,
}: {
  index: number;
  total: number;
  step: LocalStep;
  busy: boolean;
  onUpdate: (p: Partial<LocalStep>) => void;
  onSetEditing: (b: boolean) => void;
  onSave: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onAddMedia: (file: File) => void;
  onRemoveMedia: (mediaIdx: number) => void;
  onAddSubstep: () => void;
  onUpdateSubstep: (substepIdx: number, p: Partial<LocalSubstep>) => void;
  onRemoveSubstep: (substepIdx: number) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const KindIcon =
    step.kind === 'safety_check'
      ? ShieldAlert
      : step.kind === 'photo_required'
        ? Camera
        : ClipboardCheck;

  return (
    <li className="rounded-md border border-line-subtle bg-surface p-3">
      <div className="flex items-start gap-2">
        <span className="mt-1 font-mono tabular-nums text-xs text-ink-tertiary">
          {String(index + 1).padStart(2, '0')}
        </span>
        <div className="flex flex-1 flex-col gap-2 min-w-0">
          {!step.editing ? (
            <div className="flex items-center gap-2">
              <KindIcon
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-ink-secondary"
              />
              <span className="flex-1 truncate text-sm font-medium text-ink-primary">
                {step.title || <em className="text-ink-tertiary">Untitled step</em>}
              </span>
              {step.dirty && (
                <span
                  className="inline-flex h-2 w-2 shrink-0 rounded-full bg-signal-warn"
                  title="Unsaved changes"
                />
              )}
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="caption">STEP TITLE</span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={step.title}
                    onChange={(e) => onUpdate({ title: e.target.value })}
                    placeholder="Apply LOTO"
                    className="flex-1 rounded border border-line bg-surface-raised p-2 text-sm"
                    autoFocus
                  />
                  <MicButton
                    size="sm"
                    appendMode={false}
                    onTranscript={(t) => onUpdate({ title: t })}
                  />
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="caption">KIND</span>
                <select
                  value={step.kind}
                  onChange={(e) =>
                    onUpdate({ kind: e.target.value as ProcedureStepKind })
                  }
                  className="rounded border border-line bg-surface-raised p-2 text-sm"
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="caption">DETAILS</span>
                <div className="flex items-start gap-2">
                  <textarea
                    value={step.bodyMarkdown}
                    onChange={(e) => onUpdate({ bodyMarkdown: e.target.value })}
                    rows={3}
                    placeholder="What to do at this step. Markdown supported."
                    className="flex-1 rounded border border-line bg-surface-raised p-2 text-sm"
                  />
                  <MicButton
                    size="sm"
                    appendMode
                    onTranscript={(t) =>
                      onUpdate({
                        bodyMarkdown: step.bodyMarkdown
                          ? step.bodyMarkdown + ' ' + t
                          : t,
                      })
                    }
                  />
                </div>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={step.safetyCritical}
                  onChange={(e) =>
                    onUpdate({ safetyCritical: e.target.checked })
                  }
                />
                <span>Safety-critical (renders a banner)</span>
              </label>

              {/* MEDIA — author-attached photos and videos for this step. */}
              <div className="flex flex-col gap-2 rounded border border-line-subtle bg-surface-raised p-2">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="caption">PHOTOS &amp; VIDEO</span>
                    <span className="text-xs text-ink-tertiary normal-case">
                      Attached to the step content (different from run-time
                      evidence).
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="btn btn-secondary btn-sm shrink-0"
                    disabled={busy || !step.title.trim()}
                    title={
                      !step.title.trim()
                        ? 'Give the step a title first'
                        : 'Add photo or video'
                    }
                  >
                    <Camera size={12} strokeWidth={2} /> Add photo / video
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  capture="environment"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) onAddMedia(f);
                  }}
                  className="hidden"
                />
                {step.media.length > 0 ? (
                  <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {step.media.map((m, mi) => (
                      <li
                        key={`${m.storageKey}-${mi}`}
                        className="relative aspect-square overflow-hidden rounded border border-line-subtle"
                      >
                        {m.kind === 'image' ? (
                          <img
                            src={m.url ?? ''}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-surface-inset text-ink-tertiary">
                            <Video size={20} strokeWidth={1.75} />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => onRemoveMedia(mi)}
                          className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white"
                          aria-label="Remove media"
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded border border-dashed border-line bg-surface p-3 text-center text-xs text-ink-tertiary">
                    No photos or video yet. Tap{' '}
                    <span className="font-medium">Add photo / video</span> to
                    capture or upload.
                  </p>
                )}
              </div>

              {/* SUBSTEPS */}
              <div className="flex flex-col gap-2 rounded border border-line-subtle bg-surface-raised p-2">
                <div className="flex items-center justify-between">
                  <span className="caption">SUBSTEPS</span>
                  <button
                    type="button"
                    onClick={onAddSubstep}
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                  >
                    <Plus size={12} strokeWidth={2} /> Add
                  </button>
                </div>
                {step.substeps.length === 0 ? (
                  <p className="text-xs text-ink-tertiary">No substeps.</p>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {step.substeps.map((ss, si) => (
                      <li
                        key={ss.id ?? `local-${si}`}
                        className="rounded border border-line-subtle bg-surface p-2"
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-1 font-mono tabular-nums text-[10px] text-ink-tertiary">
                            {String(index + 1).padStart(2, '0')}.
                            {String(si + 1).padStart(2, '0')}
                          </span>
                          <div className="flex flex-1 flex-col gap-1.5">
                            <input
                              type="text"
                              value={ss.title}
                              onChange={(e) =>
                                onUpdateSubstep(si, { title: e.target.value })
                              }
                              placeholder="Substep title"
                              className="rounded border border-line bg-surface-raised p-1.5 text-sm"
                            />
                            <textarea
                              value={ss.bodyMarkdown}
                              onChange={(e) =>
                                onUpdateSubstep(si, {
                                  bodyMarkdown: e.target.value,
                                })
                              }
                              rows={2}
                              placeholder="Optional details"
                              className="rounded border border-line bg-surface-raised p-1.5 text-sm"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => onRemoveSubstep(si)}
                            className="rounded p-1 text-ink-tertiary hover:bg-surface hover:text-signal-fault"
                            aria-label="Remove substep"
                          >
                            <Trash2 size={12} strokeWidth={1.75} />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col items-center gap-0.5 shrink-0">
          {!step.editing && (
            <>
              <button
                type="button"
                onClick={() => onMove(-1)}
                disabled={busy || index === 0}
                className="rounded p-1 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
                aria-label="Move up"
              >
                <ChevronUp size={14} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => onMove(1)}
                disabled={busy || index === total - 1}
                className="rounded p-1 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
                aria-label="Move down"
              >
                <ChevronDown size={14} strokeWidth={1.75} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onSetEditing(!step.editing)}
            className="rounded p-1 text-ink-tertiary hover:bg-surface hover:text-ink-primary"
            aria-label={step.editing ? 'Collapse' : 'Edit'}
          >
            <Pencil size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
            aria-label="Remove step"
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {step.editing && (
        // Sticky to the bottom of the step card so the Save action is
        // always reachable while editing a tall step (lots of body /
        // photos / substeps). Opaque background + top border + small
        // shadow so the bar reads as a footer rather than blending with
        // content scrolling under it.
        <div
          className="sticky bottom-0 -mx-3 -mb-3 mt-3 flex justify-end gap-2 border-t border-line bg-surface px-3 py-2 z-10"
          style={{ boxShadow: '0 -4px 8px -4px rgba(0,0,0,0.06)' }}
        >
          <button
            type="button"
            onClick={() => onSetEditing(false)}
            className="btn btn-ghost btn-sm"
            disabled={busy}
          >
            Done
          </button>
          <button
            type="button"
            onClick={onSave}
            className="btn btn-primary btn-sm"
            disabled={busy || !step.title.trim()}
          >
            {step.id ? 'Save changes' : 'Save step'}
          </button>
        </div>
      )}
    </li>
  );
}
