'use client';

// StepCard — one inline-editable step inside the CMS editor LIST view.
// Owns:
//   - the collapsed row (default state) and the expanded toggle
//   - the <li> wrapper + drag-source / drop-target wiring
//   - default-expand on mount for newly-added steps
// Delegates the actual edit surface to <StepEditorBody chrome="list">.
// Step view uses the same StepEditorBody with chrome="step".

import { useState } from 'react';
import {
  Camera,
  ChevronDown,
  Film,
  Globe2,
  Puzzle,
  ShieldAlert,
} from 'lucide-react';
import {
  type AdminProcedureSection,
  type AdminProcedureStep,
  type AdminProcedureStepCategory,
  type AdminSiblingProcedure,
  type ProcedureStepKind,
  type UpdateProcedureStepInput,
} from '@/lib/api';
import { StepEditorBody, StepKebabMenu } from './step-editor-body';

interface Props {
  step: AdminProcedureStep;
  index: number;
  totalSteps: number;
  /** Save a partial patch. Caller manages debouncing/queuing. */
  onPatch: (patch: UpdateProcedureStepInput) => Promise<AdminProcedureStep | null>;
  onDelete: () => Promise<void>;
  /** When the voiceover panel mutates audio fields, propagate the new
   *  step shape so this card re-renders with the latest URL/source. */
  onAudioChanged: (next: AdminProcedureStep) => void;
  // Drag-and-drop wiring. Parent owns the order list; the card just
  // surfaces grab + drop affordances.
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
  /** Available sections for the kebab menu's "Move to section" picker.
   *  When omitted/empty the picker isn't shown. */
  sections?: AdminProcedureSection[];
  /** Move this step into a different section (or null for ungrouped). */
  onMoveToSection?: (sectionId: string | null) => void | Promise<void>;
  /** Default-expand the card on first mount. Pass true for newly-added
   *  steps so the author can type immediately; everything else stays
   *  collapsed so a long procedure stays scannable. */
  defaultExpanded?: boolean;
  /** Sibling structured_procedure docs in the same content pack version.
   *  Populates the "Linked sub-procedure" picker so the author can wire
   *  this step to launch another procedure when the tech taps Run. */
  siblingProcedures?: AdminSiblingProcedure[];
  /** Visible step categories (built-ins + this org's customs). Threaded
   *  in from the editor — used by the per-step category picker in the
   *  kebab menu so individual steps can carry a badge override even
   *  when their parent section has its own (or no) category. */
  categories?: AdminProcedureStepCategory[];
  /** Open the category manager modal — relayed up from the editor. */
  onManageCategories?: () => void;
}

export function StepCard({
  step,
  index,
  totalSteps,
  onPatch,
  onDelete,
  onAudioChanged,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDropTarget,
  sections,
  onMoveToSection,
  defaultExpanded = false,
  siblingProcedures,
  categories,
  onManageCategories,
}: Props) {
  // Collapsed by default — see Props.defaultExpanded. Authors scan dozens
  // of steps; only one is being actively edited at any moment, so the
  // collapsed row keeps the editing surface tight without losing context.
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);

  // Quick-glance pills shown in the collapsed row. We derive these from
  // `step` (server-authoritative) rather than local edit state — the
  // collapsed row reflects what's saved, not what's being typed in the
  // currently-expanded card elsewhere.
  const photoCount = (step.media ?? []).filter((m) => m.kind === 'image').length;
  const videoCount = (step.media ?? []).filter((m) => m.kind === 'video').length;
  const hasVoiceover = !!step.audioUrl;
  const titlePreview = step.title.trim() || 'Untitled step';

  return (
    <li
      id={`cms-step-${step.id}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-dragging={isDragging || undefined}
      data-drop-target={isDropTarget || undefined}
      className={[
        'cms-step-card relative rounded-lg border bg-surface-raised transition',
        step.safetyCritical ? 'border-signal-warn/40' : 'border-line-subtle',
        isDragging ? 'opacity-50' : '',
        isDropTarget ? 'ring-2 ring-accent/60 ring-offset-2 ring-offset-surface' : '',
        expanded ? 'shadow-sm' : 'hover:border-line',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* COLLAPSED VIEW — the default. One quiet row per step so a 50-step
          procedure scrolls without overwhelming. Click anywhere on the row
          (outside the drag handle / kebab) to expand. */}
      {!expanded && (
        <div
          className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
          onClick={() => setExpanded(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded(true);
            }
          }}
        >
          <span className="font-mono text-xs font-semibold tabular-nums text-ink-tertiary w-7 text-right shrink-0">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span
            className={[
              'min-w-0 flex-1 truncate text-sm',
              step.title.trim()
                ? 'text-ink-primary'
                : 'italic text-ink-tertiary/70',
            ].join(' ')}
          >
            {titlePreview}
          </span>
          {/* Quiet status pills — only render when set. Keeps the row
              uncluttered for plain instruction steps. */}
          {step.snippetBadge && (
            <span
              className={[
                'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0',
                step.snippetBadge.detached
                  ? 'border border-line-subtle text-ink-tertiary'
                  : 'bg-accent/10 text-accent',
              ].join(' ')}
              title={
                step.snippetBadge.detached
                  ? `Detached from snippet "${step.snippetBadge.title}". Edits stay on this step.`
                  : `From snippet "${step.snippetBadge.title}". Edits to the snippet propagate here.`
              }
            >
              {step.snippetBadge.isPlatform ? (
                <Globe2 className="size-3" />
              ) : (
                <Puzzle className="size-3" />
              )}
              <span className="max-w-[8rem] truncate">
                {step.snippetBadge.title}
              </span>
            </span>
          )}
          {step.category && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white shrink-0"
              style={{ backgroundColor: step.category.color }}
              title={`Category: ${step.category.name}`}
            >
              <span className="max-w-[6rem] truncate">
                {step.category.name}
              </span>
            </span>
          )}
          {step.safetyCritical && (
            <ShieldAlert
              className="size-3.5 text-signal-warn shrink-0"
              aria-label="Safety-critical"
            />
          )}
          {photoCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-ink-tertiary shrink-0"
              title={`${photoCount} photo${photoCount === 1 ? '' : 's'}`}
            >
              <Camera className="size-3" /> {photoCount}
            </span>
          )}
          {videoCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-ink-tertiary shrink-0"
              title={`${videoCount} video${videoCount === 1 ? '' : 's'}`}
            >
              <Film className="size-3" /> {videoCount}
            </span>
          )}
          {hasVoiceover && (
            <span
              className="text-[10px] text-ink-tertiary shrink-0"
              title="Voiceover attached"
            >
              🎧
            </span>
          )}
          <div onClick={(e) => e.stopPropagation()} className="shrink-0">
            <StepKebabMenu
              sections={sections ?? []}
              currentSectionId={step.sectionId}
              onMoveToSection={onMoveToSection}
              onDelete={() => void onDelete()}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
            className="shrink-0 rounded p-1 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Expand step"
            title="Expand"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      )}

      {/* EXPANDED VIEW — delegate to the shared editor body. */}
      {expanded && (
        <StepEditorBody
          step={step}
          index={index}
          totalSteps={totalSteps}
          onPatch={onPatch}
          onDelete={onDelete}
          onAudioChanged={onAudioChanged}
          sections={sections}
          onMoveToSection={onMoveToSection}
          siblingProcedures={siblingProcedures}
          categories={categories}
          onManageCategories={onManageCategories}
          chrome="list"
          onCollapse={() => setExpanded(false)}
          autoFocusTitle={defaultExpanded}
        />
      )}
    </li>
  );
}

// Re-exported so callers that need the helper without depending on lucide
// directly stay decoupled.
export { ListChecks } from 'lucide-react';

// Backwards-compat re-export: callers that imported StepKebabMenu from
// step-card by accident keep working. Canonical home is step-editor-body.
export { StepKebabMenu } from './step-editor-body';

// Kind options re-export for sites that want to render the same icons in
// other contexts (legacy). Keep this lightweight; the actual KIND_OPTIONS
// live in step-editor-body now.
export type { ProcedureStepKind };
