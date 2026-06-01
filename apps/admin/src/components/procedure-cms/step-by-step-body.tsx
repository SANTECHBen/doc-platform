'use client';

// StepByStepBody — the alternate (single-step focus) layout for the
// procedure editor. Same backing data and same handlers as the List
// view; just rearranged so the author edits one step at a time without
// the visual noise of a long card list.
//
// Layout:
//   ┌──────────────┬────────────────────────────────────────────────┐
//   │ <StepRail/>  │ <StepEditorBody chrome="step" key={stepId}/>   │
//   │ left sidebar │ center pane (max-w-3xl)                        │
//   │              ├────────────────────────────────────────────────┤
//   │              │ <Footer/>: Prev · "Step 02 / 10 — Removal" · Next │
//   └──────────────┴────────────────────────────────────────────────┘
//
// Navigation
//   - Click step rows in the rail.
//   - Footer Prev/Next.
//   - Keyboard ← / → and j / k. The keydown listener bails out when the
//     focused element is an input / textarea / contentEditable so arrow
//     keys keep moving the caret inside text fields.
//
// Step-edit lifecycle
//   The center pane uses StepEditorBody with key={focusedStepId} so that
//   changing focus unmounts the previous editor (triggering its unmount-
//   flush of any pending debounced save) and mounts a fresh one for the
//   new step. This prevents the last keystroke from being abandoned when
//   the author rapidly jumps between steps.

import { useCallback, useEffect, useMemo } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Plus,
} from 'lucide-react';
import {
  type AdminProcedureSection,
  type AdminProcedureStep,
  type AdminProcedureStepCategory,
  type AdminSiblingProcedure,
  type UpdateProcedureStepInput,
} from '@/lib/api';
import { StepEditorBody } from './step-editor-body';
import { StepRail } from './step-rail';

interface Props {
  steps: AdminProcedureStep[];
  sections: AdminProcedureSection[];
  /** Which step the center pane is editing. null = nothing focused (the
   *  procedure has zero steps, or the prior focus got deleted). */
  currentStepId: string | null;
  /** Update focus. Parent persists this to the URL so refresh / share-
   *  links restore the same focused step. */
  setCurrentStepId: (id: string | null) => void;
  // ── Step-editor handlers (same shape ProcedureCmsEditor passes to
  // StepCard in the List view). ──────────────────────────────────────
  onPatch: (
    stepId: string,
    patch: UpdateProcedureStepInput,
  ) => Promise<AdminProcedureStep | null>;
  onDeleteStep: (stepId: string) => Promise<void>;
  onAudioChanged: (stepId: string, next: AdminProcedureStep) => void;
  onMoveStepToSection: (stepId: string, sectionId: string | null) => void | Promise<void>;
  onAddStep: (sectionId: string | null) => void | Promise<void>;
  onAddSection: () => void | Promise<void>;
  onRenameSection: (sectionId: string, nextTitle: string) => void | Promise<void>;
  onDeleteSection: (sectionId: string) => void | Promise<void>;
  // ── Drag handlers — passthrough to the rail. ───────────────────────
  onDragStart: (stepId: string) => (e: React.DragEvent) => void;
  onDragOver: (stepId: string) => (e: React.DragEvent) => void;
  onDrop: (stepId: string) => (e: React.DragEvent) => Promise<void> | void;
  onDragEnd: () => void;
  dragId: string | null;
  dropTargetId: string | null;
  // ── Editor-side props. ─────────────────────────────────────────────
  siblingProcedures?: AdminSiblingProcedure[];
  categories?: AdminProcedureStepCategory[];
  onManageCategories?: () => void;
  bulkBusy: boolean;
  /** ID of the most-recently-added step. We auto-focus its title input
   *  on mount the same way the List view auto-expands+focuses a fresh
   *  card. */
  freshStepId: string | null;
}

export function StepByStepBody({
  steps,
  sections,
  currentStepId,
  setCurrentStepId,
  onPatch,
  onDeleteStep,
  onAudioChanged,
  onMoveStepToSection,
  onAddStep,
  onAddSection,
  onRenameSection,
  onDeleteSection,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragId,
  dropTargetId,
  siblingProcedures,
  categories,
  onManageCategories,
  bulkBusy,
  freshStepId,
}: Props) {
  // Compute the canonical display order (section orderingHint, then
  // step orderingHint inside each section, with orphans first). Used by
  // Prev/Next and the keyboard shortcuts to walk the procedure linearly.
  const orderedSteps = useMemo(() => {
    const sortedSections = [...sections].sort(
      (a, b) => a.orderingHint - b.orderingHint,
    );
    const orphans = steps
      .filter((s) => s.sectionId == null)
      .sort((a, b) => a.orderingHint - b.orderingHint);
    const inSections = sortedSections.flatMap((sec) =>
      steps
        .filter((s) => s.sectionId === sec.id)
        .sort((a, b) => a.orderingHint - b.orderingHint),
    );
    // Steps assigned to a non-existent section (data drift) still show up
    // after the known ones so the author can move them somewhere.
    const knownIds = new Set([...orphans, ...inSections].map((s) => s.id));
    const dangling = steps.filter((s) => !knownIds.has(s.id));
    return [...orphans, ...inSections, ...dangling];
  }, [steps, sections]);

  const currentIndex = currentStepId
    ? orderedSteps.findIndex((s) => s.id === currentStepId)
    : -1;
  const currentStep = currentIndex >= 0 ? orderedSteps[currentIndex] : null;
  const prevStep = currentIndex > 0 ? orderedSteps[currentIndex - 1] : null;
  const nextStep =
    currentIndex >= 0 && currentIndex < orderedSteps.length - 1
      ? orderedSteps[currentIndex + 1]
      : null;

  // Resolve the current step's section title for the footer caption.
  const currentSection = useMemo(() => {
    if (!currentStep || currentStep.sectionId == null) return null;
    return sections.find((s) => s.id === currentStep.sectionId) ?? null;
  }, [currentStep, sections]);

  const goPrev = useCallback(() => {
    if (prevStep) setCurrentStepId(prevStep.id);
  }, [prevStep, setCurrentStepId]);
  const goNext = useCallback(() => {
    if (nextStep) setCurrentStepId(nextStep.id);
  }, [nextStep, setCurrentStepId]);

  // Keyboard shortcuts — ← / →  and j / k. Bail when the user is typing
  // so arrow keys keep moving the caret inside inputs and textareas.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = document.activeElement as HTMLElement | null;
      if (t) {
        const tag = t.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (t.isContentEditable) return;
      }
      if (e.key === 'ArrowRight' || e.key === 'j') {
        if (nextStep) {
          e.preventDefault();
          goNext();
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        if (prevStep) {
          e.preventDefault();
          goPrev();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, prevStep, nextStep]);

  // Layout note: we use h-full inside a sticky-positioned wrapper that
  // ProcedureCmsEditor supplies — that wrapper carries the actual
  // viewport-height calc + sticky offset. That means StepByStepBody only
  // needs h-full to inherit. Doing it this way lets the outer page also
  // scroll naturally above/below us without the step view "running out
  // of space" mid-procedure (the bug that prompted this rewrite).
  //
  // The min-h-0 sprinkled on the flex children below is non-cosmetic:
  // without it, the flex algorithm grows the parent to fit content
  // height (defeating our explicit h-full), and overflow-y-auto on the
  // inner scrolling area silently does nothing. Symptom: when a procedure
  // has many steps, the rail or center pane gets pushed below the fold
  // and the user can't scroll to the rest.

  // Empty-procedure state — fresh doc with no steps yet.
  if (orderedSteps.length === 0) {
    return (
      <div className="grid h-full min-h-0 grid-cols-[280px_1fr] gap-0 overflow-hidden rounded-lg border border-line-subtle bg-surface-raised">
        <div className="min-h-0 overflow-hidden">
          <StepRail
            sections={sections}
            steps={steps}
            currentStepId={null}
            onFocusStep={setCurrentStepId}
            onAddStep={onAddStep}
            onAddSection={onAddSection}
            onRenameSection={onRenameSection}
            onDeleteSection={onDeleteSection}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            dragId={dragId}
            dropTargetId={dropTargetId}
            bulkBusy={bulkBusy}
          />
        </div>
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <ListChecks className="size-10 text-ink-tertiary/50" />
          <p className="text-base font-semibold text-ink-primary">
            No steps yet
          </p>
          <p className="max-w-sm text-sm text-ink-tertiary">
            Add your first step to start authoring. You can switch back to
            List view any time.
          </p>
          <button
            type="button"
            onClick={() => void onAddStep(null)}
            disabled={bulkBusy}
            className="mt-2 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
          >
            <Plus className="size-4" />
            Add first step
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[280px_1fr] gap-0 overflow-hidden rounded-lg border border-line-subtle bg-surface-raised">
      {/* min-h-0 on the rail cell so its inner overflow-y-auto actually
          engages instead of growing the grid cell to fit content. */}
      <div className="min-h-0 overflow-hidden">
        <StepRail
          sections={sections}
          steps={steps}
          currentStepId={currentStepId}
          onFocusStep={setCurrentStepId}
          onAddStep={onAddStep}
          onAddSection={onAddSection}
          onRenameSection={onRenameSection}
          onDeleteSection={onDeleteSection}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          dragId={dragId}
          dropTargetId={dropTargetId}
          bulkBusy={bulkBusy}
        />
      </div>
      <div className="flex h-full min-h-0 flex-col">
        {/* flex-1 + min-h-0 is the canonical recipe for a scrollable
            middle section that doesn't push the footer off-screen. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {currentStep ? (
            <div className="mx-auto max-w-3xl px-4 py-4">
              {/* The wrapper card matches the visual treatment of a List-
                  view expanded card so the author's muscle memory carries
                  over. Border + slight elevation, no max-height. */}
              <div
                className={[
                  'cms-step-card flex flex-col rounded-lg border bg-surface-raised shadow-sm',
                  currentStep.safetyCritical
                    ? 'border-signal-warn/40'
                    : 'border-line-subtle',
                ].join(' ')}
              >
                <StepEditorBody
                  // key forces a fresh mount on focus change so the previous
                  // step's unmount-flush ships any pending debounced save
                  // before the next step takes over.
                  key={currentStep.id}
                  step={currentStep}
                  index={currentIndex}
                  totalSteps={orderedSteps.length}
                  onPatch={(patch) => onPatch(currentStep.id, patch)}
                  onDelete={async () => {
                    // Move focus to the successor BEFORE awaiting the
                    // delete so React doesn't briefly render the doomed
                    // step as still-current (which would let our
                    // currentStepId-validator effect pick the wrong
                    // fallback). Prefer next sibling; fall back to
                    // previous; null for "no more steps left."
                    const successor =
                      nextStep?.id ?? prevStep?.id ?? null;
                    setCurrentStepId(successor);
                    await onDeleteStep(currentStep.id);
                  }}
                  onAudioChanged={(next) =>
                    onAudioChanged(currentStep.id, next)
                  }
                  sections={sections}
                  onMoveToSection={(sectionId) =>
                    onMoveStepToSection(currentStep.id, sectionId)
                  }
                  siblingProcedures={siblingProcedures}
                  categories={categories}
                  onManageCategories={onManageCategories}
                  chrome="step"
                  autoFocusTitle={freshStepId === currentStep.id}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-ink-tertiary">
              <p>Select a step from the rail to start editing.</p>
            </div>
          )}
        </div>

        {currentStep && (
          <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3">
            <span className="text-xs text-ink-tertiary">
              Step{' '}
              <span className="font-mono font-semibold tabular-nums text-ink-primary">
                {String(currentIndex + 1).padStart(2, '0')}
              </span>{' '}
              of{' '}
              <span className="font-mono font-semibold tabular-nums text-ink-primary">
                {String(orderedSteps.length).padStart(2, '0')}
              </span>
              {currentSection && (
                <>
                  <span className="mx-1.5 text-ink-tertiary/40">·</span>
                  <span className="font-medium text-ink-secondary">
                    {currentSection.title}
                  </span>
                </>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goPrev}
                disabled={!prevStep}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-40"
                title="Previous step (← or k)"
              >
                <ChevronLeft className="size-3.5" />
                Prev
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={!nextStep}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                title="Next step (→ or j)"
              >
                Next
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
