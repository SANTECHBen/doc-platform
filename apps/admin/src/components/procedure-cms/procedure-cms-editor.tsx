'use client';

// ProcedureCmsEditor — the inline, page-level authoring surface for a
// structured_procedure document. Replaces the old drawer-based steps
// tab. Goals, in priority order:
//
//   1. Direct manipulation. Every step is editable in place; no drawers,
//      no modals. Type a title, drag a step, attach voiceover — all
//      visible together.
//   2. Auto-save. Edits flush on a per-field debounce; the user never
//      thinks about a save button.
//   3. Production-ready feel. Visible save status, drag-to-reorder with
//      drop targets, sensible empty states, robust error surfaces.
//
// The component owns:
//   - The step list (server is the source of truth; we mirror locally so
//     drag-reorder feels instant).
//   - The save-status pill at the top.
//   - Drag-and-drop reorder with optimistic UI + server reconcile.
//   - Inline "Add step" affordance.
//   - "Run on PWA" deeplink (for previewing the runner end-to-end).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  createProcedureStep,
  deleteProcedureStep,
  generateProcedureStepAudio,
  reorderProcedureSteps,
  updateProcedureStep,
  updateAdminDocument,
  uploadAdminFile,
  type AdminDocumentDetail,
  type AdminProcedureDocMetadata,
  type AdminProcedureStep,
  type CreateProcedureStepInput,
  type UpdateProcedureStepInput,
} from '@/lib/api';
import { Film, Trash2, Upload as UploadIcon } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ErrorBanner } from '@/components/form';
import { StepCard } from './step-card';

interface Props {
  doc: AdminDocumentDetail;
  steps: AdminProcedureStep[];
  /** Refresh the page-level state after authoritative shape changes
   *  (delete, reorder, add). Field edits don't refetch — we trust the
   *  PATCH response. */
  onChanged: () => Promise<void> | void;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving'; pending: number }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

export function ProcedureCmsEditor({ doc, steps, onChanged }: Props) {
  // Local mirror of the steps so drag-reorder is instant. Server reconcile
  // happens on drop completion; we re-fetch via onChanged() afterwards.
  const [localSteps, setLocalSteps] = useState<AdminProcedureStep[]>(steps);
  const [pageError, setPageError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [bulkBusy, setBulkBusy] = useState(false);

  // Drag state — which step is being dragged, and which one would receive
  // the drop right now.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const toast = useToast();

  // Sync local mirror when props change (e.g. after onChanged() refresh).
  useEffect(() => {
    setLocalSteps(steps);
  }, [steps]);

  // ------------------------------------------------------------------
  // Save tracking
  // ------------------------------------------------------------------
  const pendingRef = useRef(0);
  function beginSave() {
    pendingRef.current += 1;
    setStatus({ kind: 'saving', pending: pendingRef.current });
  }
  function endSave(ok: boolean, message?: string) {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (!ok) {
      setStatus({ kind: 'error', message: message ?? 'Save failed' });
      return;
    }
    if (pendingRef.current === 0) {
      setStatus({ kind: 'saved', at: Date.now() });
      // Linger long enough for an author who's actively typing to glance
      // up and see the confirmation. Decays to "All changes saved" idle
      // state after this.
      setTimeout(
        () =>
          setStatus((s) =>
            s.kind === 'saved' && Date.now() - s.at >= 2700 ? { kind: 'idle' } : s,
          ),
        3000,
      );
    } else {
      setStatus({ kind: 'saving', pending: pendingRef.current });
    }
  }

  // ------------------------------------------------------------------
  // Per-step patch handler — used by every inline-editable field.
  // Returns the updated step so child components can refresh.
  // ------------------------------------------------------------------
  async function patchStep(
    stepId: string,
    patch: UpdateProcedureStepInput,
  ): Promise<AdminProcedureStep | null> {
    beginSave();
    try {
      const updated = await updateProcedureStep(stepId, patch);
      setLocalSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, ...updated } : s)),
      );
      endSave(true);
      return updated;
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Add / delete
  // ------------------------------------------------------------------
  async function addStep() {
    const input: CreateProcedureStepInput = {
      kind: 'instruction',
      title: '',
      bodyMarkdown: null,
      safetyCritical: false,
    };
    beginSave();
    try {
      const created = await createProcedureStep(doc.id, input);
      // Optimistic insert at the end — match server's append-with-stride.
      setLocalSteps((prev) => [...prev, created]);
      endSave(true);
      // Smooth-scroll to the new card so the focus is obvious.
      setTimeout(() => {
        document.getElementById(`cms-step-${created.id}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 50);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteStep(stepId: string) {
    const step = localSteps.find((s) => s.id === stepId);
    if (!step) return;
    if (!confirm(`Delete step "${step.title || `#${stepId.slice(0, 6)}`}"? This can't be undone.`)) {
      return;
    }
    beginSave();
    try {
      await deleteProcedureStep(stepId);
      setLocalSteps((prev) => prev.filter((s) => s.id !== stepId));
      endSave(true);
    } catch (e) {
      // Most common 409: existing run completions reference this step.
      // We surface that with a useful message rather than swallow.
      endSave(false, e instanceof Error ? e.message : String(e));
      toast.error(
        'Could not delete step',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // ------------------------------------------------------------------
  // Drag-and-drop reorder. HTML5 native — keeps the dependency surface
  // small. We track the dragged id + the would-be drop target; on drop
  // we splice locally for instant feedback, then PATCH the server.
  // ------------------------------------------------------------------
  function onDragStart(id: string) {
    return (e: React.DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      // Hide the default browser drag image — our card visual reads cleaner
      // with the natural translate from the cursor.
    };
  }
  function onDragOver(id: string) {
    return (e: React.DragEvent) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTargetId !== id) setDropTargetId(id);
    };
  }
  function onDrop(targetId: string) {
    return async (e: React.DragEvent) => {
      e.preventDefault();
      const sourceId = dragId ?? e.dataTransfer.getData('text/plain');
      setDragId(null);
      setDropTargetId(null);
      if (!sourceId || sourceId === targetId) return;
      const src = localSteps.findIndex((s) => s.id === sourceId);
      const tgt = localSteps.findIndex((s) => s.id === targetId);
      if (src < 0 || tgt < 0) return;
      const next = [...localSteps];
      const [moved] = next.splice(src, 1);
      if (!moved) return;
      next.splice(tgt, 0, moved);
      setLocalSteps(next);
      beginSave();
      try {
        await reorderProcedureSteps(
          doc.id,
          next.map((s) => s.id),
        );
        endSave(true);
        await onChanged();
      } catch (err) {
        endSave(false, err instanceof Error ? err.message : String(err));
        toast.error(
          'Reorder failed',
          err instanceof Error ? err.message : String(err),
        );
        // Roll back on failure.
        setLocalSteps(localSteps);
      }
    };
  }
  function onDragEnd() {
    setDragId(null);
    setDropTargetId(null);
  }

  // ------------------------------------------------------------------
  // Bulk: generate audio for all steps that don't have it. Useful right
  // after promoting an AI answer — one click and the whole procedure
  // has voice.
  // ------------------------------------------------------------------
  async function generateAllAudio() {
    const targets = localSteps.filter((s) => !s.audioUrl && s.title.trim());
    if (targets.length === 0) {
      toast.info('Every step already has voiceover', 'Or no steps have a title yet.');
      return;
    }
    if (
      !confirm(
        `Generate AI voiceover for ${targets.length} step${targets.length === 1 ? '' : 's'}? This will use OpenAI TTS — about ${Math.ceil(targets.length * 2.5)}¢ total.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const s of targets) {
      try {
        beginSave();
        const r = await generateProcedureStepAudio(s.id);
        setLocalSteps((prev) =>
          prev.map((p) =>
            p.id === s.id
              ? {
                  ...p,
                  audioStorageKey: 'set',
                  audioContentType: r.audioContentType,
                  audioSizeBytes: r.audioSizeBytes,
                  audioSource: r.audioSource,
                  audioUrl: r.audioUrl,
                  audioDurationMs: null,
                }
              : p,
          ),
        );
        endSave(true);
        ok += 1;
      } catch (e) {
        endSave(false, e instanceof Error ? e.message : String(e));
        fail += 1;
      }
    }
    setBulkBusy(false);
    if (fail === 0) {
      toast.success(`Generated voiceover for ${ok} steps`);
    } else if (ok === 0) {
      toast.error('All audio generations failed');
    } else {
      toast.success(`Generated ${ok} steps`, `${fail} failed — try again on those.`);
    }
  }

  const empty = localSteps.length === 0;
  const hasAudioCount = useMemo(
    () => localSteps.filter((s) => s.audioUrl).length,
    [localSteps],
  );

  return (
    <div className="space-y-4">
      <ErrorBanner error={pageError} />

      {/* Sticky status / action bar */}
      <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-line-subtle bg-surface-raised/80 px-4 py-2.5 backdrop-blur-md">
        <SaveStatusPill status={status} />
        <span className="text-xs text-ink-tertiary">
          {localSteps.length} step{localSteps.length === 1 ? '' : 's'}
          {' · '}
          {hasAudioCount} with voiceover
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={generateAllAudio}
            disabled={bulkBusy || empty}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
            title="Generate AI voiceover for every step that doesn't have one yet"
          >
            {bulkBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )}
            Generate all audio
          </button>
          {doc.kind === 'structured_procedure' && (
            <>
              <a
                href={`/procedures/${encodeURIComponent(doc.id)}/edit`}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs font-medium text-accent transition hover:border-accent hover:bg-accent/10"
                title="Open the distraction-free full-page authoring view"
              >
                <ExternalLink className="size-3.5" />
                Full-page editor
              </a>
              <a
                href={`/documents/${encodeURIComponent(doc.id)}?tab=overview`}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5"
              >
                Overview
              </a>
            </>
          )}
        </div>
      </div>

      {/* Intro video — procedure-level. Renders on the PWA's Step 0
          landing page in Job Aid view and at the top of the scroll
          view. Optional; only matters for training-style procedures. */}
      {doc.kind === 'structured_procedure' && (
        <HeroVideoSection doc={doc} onChanged={onChanged} />
      )}

      {empty ? (
        <EmptyState onAdd={addStep} />
      ) : (
        <ol className="flex flex-col gap-3" onDragEnd={onDragEnd}>
          {localSteps.map((s, i) => (
            <div key={s.id} id={`cms-step-${s.id}`}>
              <StepCard
                step={s}
                index={i}
                totalSteps={localSteps.length}
                onPatch={(patch) => patchStep(s.id, patch)}
                onDelete={() => deleteStep(s.id)}
                onAudioChanged={(next) =>
                  setLocalSteps((prev) =>
                    prev.map((p) => (p.id === s.id ? next : p)),
                  )
                }
                draggable={!bulkBusy}
                onDragStart={onDragStart(s.id)}
                onDragOver={onDragOver(s.id)}
                onDrop={onDrop(s.id)}
                onDragEnd={onDragEnd}
                isDragging={dragId === s.id}
                isDropTarget={dropTargetId === s.id && dragId !== s.id}
              />
            </div>
          ))}
        </ol>
      )}

      <button
        type="button"
        onClick={addStep}
        className="group flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-4 text-sm font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
      >
        <Plus className="size-4 transition group-hover:rotate-90" />
        Add step
      </button>
    </div>
  );
}

function SaveStatusPill({ status }: { status: SaveStatus }) {
  // Larger, higher-contrast surfaces — auto-save is invisible if the
  // status pill is too quiet to notice.
  if (status.kind === 'saving') {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-accent px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm">
        <Loader2 className="size-4 animate-spin" />
        Saving…
      </span>
    );
  }
  if (status.kind === 'saved') {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-signal-ok px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm"
        // Brief flash so the author actually sees the confirmation before
        // it decays back to the steady-state pill.
      >
        <CheckCircle2 className="size-4" />
        Saved
      </span>
    );
  }
  if (status.kind === 'error') {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-signal-fault px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm"
        title={status.message}
      >
        <AlertTriangle className="size-4" />
        Save failed — retry
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm font-medium text-ink-secondary">
      <CheckCircle2 className="size-4 text-signal-ok" />
      All changes saved
    </span>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface-raised px-6 py-16 text-center">
      <Sparkles className="size-7 text-accent/60" />
      <p className="text-base font-semibold text-ink-primary">
        Author your first step
      </p>
      <p className="max-w-md text-sm text-ink-tertiary">
        Each step becomes a card the tech walks through hands-free —
        with custom voiceover, photos, and (optional) measurement evidence.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
      >
        <Plus className="size-4" />
        Add first step
      </button>
    </div>
  );
}

// HeroVideoSection — procedure-level intro-video authoring card. Sits
// above the step list. Optional feature; most procedures won't use it,
// but training-style procedures (LOTO, safety briefings) benefit from
// a single overview video at the top of the walkthrough.
function HeroVideoSection({
  doc,
  onChanged,
}: {
  doc: AdminDocumentDetail;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hero = doc.procedureMetadata?.heroVideo ?? null;

  // Build the metadata object to PATCH. Always send the full shape so
  // we don't accidentally drop tools/safety/verification when patching
  // just the hero.
  function buildMetadata(
    heroPatch: AdminProcedureDocMetadata['heroVideo'] | null,
  ): AdminProcedureDocMetadata {
    const base = doc.procedureMetadata ?? {
      toolsRequired: [],
      safety: { enabled: false, notes: null },
      verification: { enabled: false, notes: null },
    };
    return {
      ...base,
      heroVideo: heroPatch,
    };
  }

  async function onPick(file: File) {
    setBusy(true);
    setError(null);
    try {
      if (!file.type.startsWith('video/')) {
        throw new Error('Please choose a video file.');
      }
      const uploaded = await uploadAdminFile(file);
      const meta = buildMetadata({
        storageKey: uploaded.storageKey,
        mime: uploaded.contentType,
        sizeBytes: uploaded.size,
        caption: hero?.caption ?? null,
      });
      await updateAdminDocument(doc.id, { procedureMetadata: meta });
      await onChanged();
      toast.success('Intro video uploaded.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(`Upload failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (!hero) return;
    setBusy(true);
    setError(null);
    try {
      const meta = buildMetadata(null);
      await updateAdminDocument(doc.id, { procedureMetadata: meta });
      await onChanged();
      toast.success('Intro video removed.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(`Update failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line-subtle bg-surface-raised p-4">
      <div className="mb-2 flex items-center gap-2">
        <Film className="size-4 text-accent" />
        <h3 className="text-sm font-semibold text-ink-primary">Intro video</h3>
        <span className="text-xs text-ink-tertiary">
          Optional — shows on Step 0 of the Job Aid view
        </span>
      </div>
      {error && (
        <p className="mb-2 text-xs text-signal-fault" role="alert">
          {error}
        </p>
      )}
      {hero ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {hero.url && (
            <video
              src={hero.url}
              controls
              preload="metadata"
              className="aspect-video w-full max-w-sm rounded border border-line bg-black"
            />
          )}
          <div className="flex flex-1 flex-col gap-2 text-xs text-ink-secondary">
            <div>
              <span className="text-ink-tertiary">Type:</span> {hero.mime}
            </div>
            {hero.sizeBytes !== undefined && (
              <div>
                <span className="text-ink-tertiary">Size:</span>{' '}
                {(hero.sizeBytes / (1024 * 1024)).toFixed(2)} MB
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <label
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 ${
                  busy ? 'pointer-events-none opacity-50' : ''
                }`}
              >
                <UploadIcon className="size-3.5" />
                Replace
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPick(f);
                    e.target.value = '';
                  }}
                  className="hidden"
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                onClick={onRemove}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-signal-fault transition hover:border-signal-fault/40 hover:bg-signal-fault/5 disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <label
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 ${
            busy ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          <UploadIcon className="size-3.5" />
          {busy ? 'Uploading…' : 'Upload intro video'}
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/webm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPick(f);
              e.target.value = '';
            }}
            className="hidden"
            disabled={busy}
          />
        </label>
      )}
    </div>
  );
}
