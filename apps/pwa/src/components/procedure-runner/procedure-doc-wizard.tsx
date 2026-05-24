'use client';

// ProcedureDocWizard — radically simplified field-authoring UX for the
// PWA. Designed for technicians on equipment, in noisy environments,
// possibly with gloves on. Four screens, full-bleed, big tap targets,
// voice on every text input.
//
//   1. CATEGORY — what kind of procedure? PM / Troubleshooting / R&R /
//                 Walkthrough. Drives which Maintenance bucket the
//                 saved procedure shows up in. Must come first so the
//                 tech sets context before naming anything.
//   2. TITLE — what procedure are you documenting?
//   3. STEP  — what did you do? + photo/video. Repeats per step.
//   4. REVIEW — see captured steps + Save procedure.
//
// Advanced authoring (kind picker, body markdown, substeps, safety
// flag, measurement spec, tools required, verification notes) is
// admin-only — those fields are reachable on /documents/:id once the
// procedure is saved. The wizard intentionally exposes none of that.

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Video,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  abandonProcedureRun,
  addAuthoringStep,
  completeAuthoring,
  finalizeAuthoring,
  startFieldProcedure,
  updateAuthoringStep,
  uploadStepMedia,
  type AuthoredProcedureCategory,
  type ProcedureBundle,
  type ProcedureStepMedia,
} from '@/lib/api';
import { MicButton } from '@/components/voice-input';
import { PhotoEditor } from '@/components/photo-editor';
import { ProcedureIntake } from '@/components/procedure-intake';

// 'intake' covers the shared category + title screens that ProcedureIntake
// owns; 'step' and 'review' are the wizard's own capture surfaces.
type WizardMode = 'intake' | 'step' | 'review';

interface CapturedStep {
  // null until the step is saved server-side (first media upload OR Next tap).
  id: string | null;
  title: string;
  body: string;
  media: ProcedureStepMedia[];
}

function freshStep(): CapturedStep {
  return { id: null, title: '', body: '', media: [] };
}

export function ProcedureDocWizard({
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
  const [procedureTitle, setProcedureTitle] = useState('');
  const [procedureCategory, setProcedureCategory] =
    useState<AuthoredProcedureCategory | null>(null);
  const [steps, setSteps] = useState<CapturedStep[]>([freshStep()]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [mode, setMode] = useState<WizardMode>('intake');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bottom-sheet picker: null = closed, otherwise the user is choosing
  // a media source. Three hidden file inputs target each source so the
  // browser uses the right intent (camera vs library) on iOS/Android.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Photo waiting for crop/markup before upload. Videos skip this and
  // go straight to upload.
  const [editingPhoto, setEditingPhoto] = useState<File | null>(null);

  const cameraPhotoRef = useRef<HTMLInputElement>(null);
  const cameraVideoRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  // Lock body scroll while overlay is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Run + backing document are created LATER — when the tech commits
  // intake (category + title). Creating it on mount used to leave an
  // "Untitled procedure" stub in the field_captures pack whenever a
  // tech opened the wizard and bailed before naming anything; the
  // user saw those as click-to-nowhere rows in Maintenance. By
  // deferring until we know the real title we never write a
  // placeholder.

  const currentStep = steps[currentIdx]!;

  function updateCurrent(partial: Partial<CapturedStep>) {
    setSteps((prev) => prev.map((s, i) => (i === currentIdx ? { ...s, ...partial } : s)));
  }

  // Persist the current step server-side. POSTs a new step or PATCHes an
  // existing one (when re-edited from Review). Returns the saved step's id.
  async function persistCurrent(): Promise<string | null> {
    if (!bundle) return null;
    const step = steps[currentIdx];
    if (!step) return null;
    if (!step.title.trim()) {
      throw new Error('Add a title for this step first.');
    }
    // PWA wizard only ever produces image/video uploads — never the
    // drafter's video_clip variant — so we forward each item with its
    // original discriminator and let the API's discriminated-union
    // validator handle the shape. We don't strip the clip field for
    // video_clip items in the unlikely case one's pre-attached (e.g.,
    // a future re-edit flow); the spread preserves it.
    const stepInput = {
      kind: 'instruction' as const,
      title: step.title.trim(),
      bodyMarkdown: step.body.trim() || null,
      media: step.media.map((m) => {
        const captionPart = m.caption ? { caption: m.caption } : {};
        if (m.kind === 'video_clip') {
          return {
            kind: 'video_clip' as const,
            storageKey: m.storageKey,
            mime: m.mime,
            clip: m.clip,
            ...captionPart,
          };
        }
        return {
          kind: m.kind,
          storageKey: m.storageKey,
          mime: m.mime,
          ...captionPart,
        };
      }),
    };
    if (step.id) {
      const dto = await updateAuthoringStep({
        runId: bundle.run.id,
        stepId: step.id,
        step: stepInput,
        devUserId,
        devOrgId,
      });
      return dto.id;
    }
    const dto = await addAuthoringStep({
      runId: bundle.run.id,
      step: stepInput,
      devUserId,
      devOrgId,
    });
    setSteps((prev) => prev.map((s, i) => (i === currentIdx ? { ...s, id: dto.id } : s)));
    return dto.id;
  }

  async function ensureStepIdForUpload(): Promise<string | null> {
    if (!bundle) return null;
    const step = steps[currentIdx];
    if (!step) return null;
    if (step.id) return step.id;
    if (!step.title.trim()) {
      throw new Error('Add a title for this step before capturing media.');
    }
    return persistCurrent();
  }

  function openMediaPicker() {
    if (!currentStep.title.trim()) {
      setError('Add a step title first.');
      return;
    }
    setError(null);
    setPickerOpen(true);
  }

  function pickFrom(source: 'camera-photo' | 'camera-video' | 'library') {
    setPickerOpen(false);
    const ref =
      source === 'camera-photo'
        ? cameraPhotoRef
        : source === 'camera-video'
          ? cameraVideoRef
          : libraryRef;
    // requestAnimationFrame so the sheet has a chance to unmount before
    // the synthetic file-input click — older Safari occasionally drops
    // the click if it's on the same paint as the sheet teardown.
    requestAnimationFrame(() => ref.current?.click());
  }

  function onPickMedia(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !bundle) return;
    // Stills go through the crop/markup editor first; videos upload as-is.
    if (file.type.startsWith('image/')) {
      setEditingPhoto(file);
      return;
    }
    void uploadAndAttach(file);
  }

  // Common upload path used both for raw videos and edited photo blobs.
  async function uploadAndAttach(file: File) {
    if (!bundle) return;
    setBusy(true);
    setError(null);
    try {
      const stepId = await ensureStepIdForUpload();
      if (!stepId) return;
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
      const nextMedia = [...currentStep.media, newMedia];
      updateCurrent({ media: nextMedia });
      await updateAuthoringStep({
        runId: bundle.run.id,
        stepId,
        step: { media: nextMedia },
        devUserId,
        devOrgId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPhotoEditorSave(blob: Blob) {
    const original = editingPhoto;
    setEditingPhoto(null);
    if (!original) return;
    const baseName = original.name.replace(/\.[^.]+$/, '') || 'photo';
    const edited = new File([blob], `${baseName}-edited.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
    await uploadAndAttach(edited);
  }

  async function removeMedia(mediaIdx: number) {
    if (!bundle) return;
    const step = steps[currentIdx];
    if (!step?.id) {
      // No server save yet — just drop locally.
      updateCurrent({
        media: currentStep.media.filter((_, i) => i !== mediaIdx),
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = currentStep.media.filter((_, i) => i !== mediaIdx);
      updateCurrent({ media: next });
      await updateAuthoringStep({
        runId: bundle.run.id,
        stepId: step.id,
        step: { media: next },
        devUserId,
        devOrgId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onNextStep() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await persistCurrent();
      // Either advance to a new draft (extending the steps array) or
      // jump to the next existing one (when navigating from Review).
      if (currentIdx === steps.length - 1) {
        setSteps((prev) => [...prev, freshStep()]);
      }
      setCurrentIdx((idx) => idx + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onGotoReview() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await persistCurrent();
      setMode('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFinishProcedure() {
    if (!bundle) return;
    if (!procedureCategory || !procedureTitle.trim()) {
      // Should be impossible — intake is the first wizard mode and we
      // never advance without both. Defensive: bounce back to intake.
      setError(
        !procedureCategory ? 'Pick a procedure type first.' : 'Add a title for the procedure first.',
      );
      setMode('intake');
      return;
    }
    const savedSteps = steps.filter((s) => s.id);
    if (savedSteps.length === 0) {
      setError('Add at least one step before finishing.');
      setMode('step');
      setCurrentIdx(0);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await finalizeAuthoring({
        runId: bundle.run.id,
        title: procedureTitle.trim(),
        scopeAssetInstanceOnly: false,
        linkedPartIds: [],
        procedureCategory,
        devUserId,
        devOrgId,
      });
      await completeAuthoring(bundle.run.id, devUserId, devOrgId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCancelAll() {
    if (!bundle) {
      onClose();
      return;
    }
    const hasContent =
      procedureCategory !== null ||
      procedureTitle.trim() ||
      steps.some((s) => s.title.trim() || s.id);
    if (hasContent && !confirm('Discard this draft procedure? Your captured steps will be lost.')) {
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
      // ignore
    }
    onClose();
  }

  function gotoStep(idx: number) {
    setCurrentIdx(idx);
    setMode('step');
  }

  // ---- INTAKE (category + title) — delegated to the shared component
  // so the manual wizard and the AI walkthrough flow present these two
  // screens identically. Commit creates the run + backing document
  // (with the real title) and transitions us into capture; cancel
  // tears down the whole wizard. Rendered BEFORE the bundle-null
  // branches because intake intentionally runs without a bundle —
  // the bundle gets created at intake commit time.
  if (mode === 'intake') {
    return (
      <ProcedureIntake
        kicker="DOCUMENT A PROCEDURE"
        title="Document a procedure"
        totalSteps={3}
        initialCategory={procedureCategory}
        initialTitle={procedureTitle}
        onCancel={onCancelAll}
        onCommit={async ({ category, title }) => {
          // Create the run + backing document NOW (with the real
          // title) instead of at wizard mount. If startFieldProcedure
          // throws, ProcedureIntake catches and surfaces the error
          // inline so the tech can retry without losing what they typed.
          setProcedureCategory(category);
          setProcedureTitle(title);
          // Idempotent: if the tech navigates back to intake then
          // forward again (mode === 'intake' more than once) we'd
          // otherwise create a second backing doc. Reuse the existing
          // bundle when one's already in flight.
          if (!bundle) {
            const b = await startFieldProcedure({
              assetInstanceId,
              title,
              devUserId,
              devOrgId,
            });
            setBundle(b);
          }
          setMode('step');
        }}
      />
    );
  }

  // ---- Loading / error states ---------------------------------------
  // Past intake, every other mode reads from `bundle` (run id, etc.).
  // If the run creation failed at intake commit, surface the error and
  // let the tech retry by going Back to intake. If somehow we landed
  // in step mode without a bundle (shouldn't happen), the same
  // "Initializing…" panel acts as a safety net.

  if (!bundle && error) {
    return (
      <FullScreenShell title="Couldn't start" onClose={onClose}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-signal-fault">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode('intake');
            }}
            className="btn btn-secondary"
          >
            Back to intake
          </button>
        </div>
      </FullScreenShell>
    );
  }
  if (!bundle) {
    return (
      <FullScreenShell title="Starting…" onClose={onClose}>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-tertiary">
          Initializing…
        </div>
      </FullScreenShell>
    );
  }

  // ---- REVIEW screen ------------------------------------------------

  if (mode === 'review') {
    const savedCount = steps.filter((s) => s.id).length;
    return (
      <FullScreenShell
        title="Review &amp; finish"
        onBack={() => {
          setMode('step');
          setCurrentIdx(steps.length - 1);
        }}
        onClose={onCancelAll}
        rightActionLabel="Cancel"
      >
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          <div>
            <p className="caption mb-1">PROCEDURE</p>
            <h2 className="text-2xl font-bold text-ink-primary">
              {procedureTitle.trim() || 'Untitled procedure'}
            </h2>
            <p className="mt-1 text-sm text-ink-tertiary">
              {savedCount} step{savedCount === 1 ? '' : 's'} captured
            </p>
          </div>
          <ol className="flex flex-col gap-2">
            {steps
              .filter((s) => s.id || s.title.trim())
              .map((s, i) => (
                <li key={s.id ?? `local-${i}`}>
                  <button
                    type="button"
                    onClick={() => gotoStep(steps.indexOf(s))}
                    className="surface-etched flex w-full items-center gap-3 px-4 py-3 text-left"
                  >
                    <span className="font-mono tabular-nums text-sm text-ink-tertiary shrink-0">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-medium text-ink-primary">
                        {s.title || <em className="text-ink-tertiary">Untitled step</em>}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-tertiary">
                        {s.media.length > 0
                          ? `${s.media.length} attachment${s.media.length === 1 ? '' : 's'}`
                          : 'No attachments'}
                      </p>
                    </div>
                    <Pencil size={16} strokeWidth={1.75} className="shrink-0 text-ink-tertiary" />
                  </button>
                </li>
              ))}
          </ol>
          {error && <p className="text-sm text-signal-fault">{error}</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface-raised px-6 py-4">
          <button
            type="button"
            onClick={() => {
              setSteps((prev) => [...prev, freshStep()]);
              setCurrentIdx(steps.length);
              setMode('step');
            }}
            className="btn btn-secondary"
            disabled={busy}
          >
            <Plus size={16} strokeWidth={2} /> Add another step
          </button>
          <button
            type="button"
            onClick={onFinishProcedure}
            className="btn btn-primary"
            disabled={busy || savedCount === 0}
          >
            <Check size={16} strokeWidth={2} /> Save procedure
          </button>
        </footer>
      </FullScreenShell>
    );
  }

  // ---- STEP screen --------------------------------------------------

  const totalDraftedOrSaved = steps.filter((s, i) => s.id || i === currentIdx).length;
  const stepNum = currentIdx + 1;
  const canAdvance = currentStep.title.trim().length > 0;

  return (
    <FullScreenShell
      title={procedureTitle.trim() || 'Untitled procedure'}
      onBack={() => {
        if (currentIdx === 0) {
          // Step 1 → back to intake so the tech can edit category/title.
          setMode('intake');
        } else {
          setCurrentIdx(currentIdx - 1);
        }
      }}
      onClose={onCancelAll}
      rightActionLabel="Cancel"
    >
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-4">
        <div>
          <p className="caption">
            Step {String(stepNum).padStart(2, '0')}
            {totalDraftedOrSaved > stepNum
              ? ` of ${String(totalDraftedOrSaved).padStart(2, '0')}`
              : ''}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-ink-primary">
            What did you do at this step?
          </h2>
        </div>

        <label className="flex flex-col gap-2">
          <span className="caption">STEP TITLE</span>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={currentStep.title}
              onChange={(e) => updateCurrent({ title: e.target.value })}
              placeholder="Apply LOTO · Replace bearing race"
              className="flex-1 rounded-md border border-line bg-surface-raised p-4 text-base font-medium"
              autoFocus
            />
            <MicButton
              size="md"
              appendMode={false}
              onTranscript={(t) => updateCurrent({ title: t })}
            />
          </div>
        </label>

        <label className="flex flex-col gap-2">
          <span className="caption">DETAILS (OPTIONAL)</span>
          <div className="flex items-start gap-2">
            <textarea
              value={currentStep.body}
              onChange={(e) => updateCurrent({ body: e.target.value })}
              rows={3}
              placeholder="Anything tricky a tech should know"
              className="flex-1 rounded-md border border-line bg-surface-raised p-3 text-sm"
            />
            <MicButton
              size="md"
              appendMode
              onTranscript={(t) =>
                updateCurrent({
                  body: currentStep.body ? currentStep.body + ' ' + t : t,
                })
              }
            />
          </div>
        </label>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="caption">PHOTOS &amp; VIDEO</span>
            <button
              type="button"
              onClick={openMediaPicker}
              className="btn btn-secondary btn-sm"
              disabled={busy || !currentStep.title.trim()}
              title={currentStep.title.trim() ? 'Add photo or video' : 'Add a step title first'}
            >
              <Camera size={14} strokeWidth={2} /> Add photo / video
            </button>
          </div>
          {/* Three intent-specific inputs. iOS/Android pick the right
              source from the (accept, capture) pair: an image-only
              accept + capture opens the camera in photo mode; video-only
              opens it in video mode; image,video without capture opens
              the library/picker. Keeping them separate avoids the
              "gallery only" trap that hits combined accept + capture. */}
          <input
            ref={cameraPhotoRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onPickMedia}
            className="hidden"
          />
          <input
            ref={cameraVideoRef}
            type="file"
            accept="video/*"
            capture="environment"
            onChange={onPickMedia}
            className="hidden"
          />
          <input
            ref={libraryRef}
            type="file"
            accept="image/*,video/*"
            onChange={onPickMedia}
            className="hidden"
          />
          {currentStep.media.length === 0 ? (
            <button
              type="button"
              onClick={openMediaPicker}
              className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface-raised p-8 text-sm text-ink-tertiary transition hover:border-brand/40 hover:text-ink-primary"
              disabled={busy}
            >
              <Camera size={28} strokeWidth={1.5} />
              <span>Tap to capture or upload</span>
              <span className="text-xs text-ink-tertiary">
                Photo or video, from camera or library
              </span>
            </button>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {currentStep.media.map((m, mi) => (
                <li
                  key={`${m.storageKey}-${mi}`}
                  className="relative aspect-square overflow-hidden rounded border border-line-subtle"
                >
                  {m.kind === 'image' ? (
                    <img src={m.url ?? ''} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-surface-inset text-ink-tertiary">
                      <Video size={20} strokeWidth={1.75} />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeMedia(mi)}
                    className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white"
                    aria-label="Remove media"
                    disabled={busy}
                  >
                    <Trash2 size={12} strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && <p className="text-sm text-signal-fault">{error}</p>}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface-raised px-6 py-4">
        <button
          type="button"
          onClick={onGotoReview}
          className="btn btn-ghost"
          disabled={busy || !canAdvance}
        >
          <Check size={16} strokeWidth={2} /> Finish
        </button>
        <button
          type="button"
          onClick={onNextStep}
          className="btn btn-primary"
          disabled={busy || !canAdvance}
        >
          Next step <ChevronRight size={16} strokeWidth={2} />
        </button>
      </footer>
      {pickerOpen && <MediaSourceSheet onPick={pickFrom} onCancel={() => setPickerOpen(false)} />}
      {editingPhoto && (
        <PhotoEditor
          file={editingPhoto}
          onSave={onPhotoEditorSave}
          onCancel={() => setEditingPhoto(null)}
        />
      )}
    </FullScreenShell>
  );
}

// MediaSourceSheet — bottom-sheet action menu so the tech explicitly
// chooses Take photo / Take video / Library. Avoids the browser-
// dependent ambiguity of a single combined file input where some
// platforms (notably iOS Safari) collapse "image,video + capture" into
// a gallery-only Photo picker with no camera shortcut.
function MediaSourceSheet({
  onPick,
  onCancel,
}: {
  onPick: (source: 'camera-photo' | 'camera-video' | 'library') => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add media"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-xl bg-surface-raised p-2 sm:rounded-xl"
      >
        <button
          type="button"
          onClick={() => onPick('camera-photo')}
          className="flex w-full items-center gap-3 rounded-md p-4 text-left text-base hover:bg-surface-elevated"
        >
          <Camera size={22} strokeWidth={1.75} className="text-ink-secondary" />
          <span className="font-medium">Take photo</span>
        </button>
        <button
          type="button"
          onClick={() => onPick('camera-video')}
          className="flex w-full items-center gap-3 rounded-md p-4 text-left text-base hover:bg-surface-elevated"
        >
          <Video size={22} strokeWidth={1.75} className="text-ink-secondary" />
          <span className="font-medium">Record video</span>
        </button>
        <button
          type="button"
          onClick={() => onPick('library')}
          className="flex w-full items-center gap-3 rounded-md p-4 text-left text-base hover:bg-surface-elevated"
        >
          <ImagePlus size={22} strokeWidth={1.75} className="text-ink-secondary" />
          <span className="font-medium">Choose from library</span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-md p-3 text-sm text-ink-tertiary hover:bg-surface-elevated"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Shell — full-screen overlay chrome with top bar (back / title /
// cancel) and a flex column body the screens fill in.
// ---------------------------------------------------------------------
function FullScreenShell({
  title,
  onBack,
  onClose,
  rightActionLabel,
  children,
}: {
  title: string;
  onBack?: () => void;
  onClose: () => void;
  rightActionLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="doc-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onBack ?? onClose}
          className="app-topbar-btn"
          aria-label={onBack ? 'Back' : 'Close'}
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="caption">DOCUMENT A PROCEDURE</span>
          <h2 className="truncate text-base font-semibold">{title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="app-topbar-btn"
          aria-label={rightActionLabel ?? 'Close'}
        >
          <X size={20} strokeWidth={2} />
        </button>
      </header>
      {children}
    </div>
  );
}
