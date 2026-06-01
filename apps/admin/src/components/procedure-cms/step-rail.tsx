'use client';

// StepRail — left sidebar in the step-by-step editor view. Shows the
// whole procedure outline (sections + their steps) so the author keeps
// their bearings while editing one step at a time in the center pane.
//
// Capabilities:
//   - Click a step row → focus it in the center pane.
//   - Drag-reorder steps within a section. Cross-section moves use the
//     step kebab's "Move to section" submenu (same affordance as List
//     view); rail drag stays scoped to one section to keep DnD legible.
//   - Inline-edit section title with the same race-safe debounce the
//     List view uses (lastSentTitleRef + flush-on-unmount). Identical
//     guard to the one in procedure-cms-editor.tsx#SectionGroup.
//   - "+ Add step" per section, plus a tail "+ Add section" affordance.
//   - Section kebab: delete (children become orphans, never deleted).
//
// State stays in the parent ProcedureCmsEditor; this component is mostly
// presentational + thin debounced-input wrappers.

import { useEffect, useRef, useState } from 'react';
import {
  ChevronUp,
  ChevronDown,
  GripVertical,
  ListChecks,
  MoreVertical,
  Plus,
  Puzzle,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  type AdminProcedureSection,
  type AdminProcedureStep,
} from '@/lib/api';

interface Props {
  sections: AdminProcedureSection[];
  steps: AdminProcedureStep[];
  /** Currently-focused step in the center pane. Highlighted in the rail. */
  currentStepId: string | null;
  /** Set the focused step. */
  onFocusStep: (stepId: string) => void;
  /** Add a new step in the given section (null = orphan / ungrouped). */
  onAddStep: (sectionId: string | null) => void | Promise<void>;
  /** Open the snippet picker for the given section (null = orphan
   *  / ungrouped). Picking a snippet creates a new step in that section
   *  backed by the snippet — same wiring the List view uses. */
  onInsertSnippet: (sectionId: string | null) => void;
  /** Add a new section. The editor handles the title prompt UX. */
  onAddSection: () => void | Promise<void>;
  /** Rename a section. */
  onRenameSection: (sectionId: string, nextTitle: string) => void | Promise<void>;
  /** Delete a section (children become orphans). */
  onDeleteSection: (sectionId: string) => void | Promise<void>;
  // Drag handlers — same shape ProcedureCmsEditor exposes for the List view
  // cards. We piggyback on the existing optimistic-reorder pipeline so
  // rail drags and list drags share the same backend wiring.
  onDragStart: (stepId: string) => (e: React.DragEvent) => void;
  onDragOver: (stepId: string) => (e: React.DragEvent) => void;
  onDrop: (stepId: string) => (e: React.DragEvent) => Promise<void> | void;
  onDragEnd: () => void;
  dragId: string | null;
  dropTargetId: string | null;
  /** Disable mutate buttons during bulk operations (e.g. Generate All Audio). */
  bulkBusy: boolean;
}

export function StepRail({
  sections,
  steps,
  currentStepId,
  onFocusStep,
  onAddStep,
  onInsertSnippet,
  onAddSection,
  onRenameSection,
  onDeleteSection,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragId,
  dropTargetId,
  bulkBusy,
}: Props) {
  // Group steps the same way the List view does: orphans first
  // (sectionId === null), then each section in orderingHint order with
  // its steps sorted by orderingHint inside.
  const sortedSections = [...sections].sort(
    (a, b) => a.orderingHint - b.orderingHint,
  );
  const orphanSteps = steps
    .filter((s) => s.sectionId == null)
    .sort((a, b) => a.orderingHint - b.orderingHint);
  const sectionGroups = sortedSections.map((sec) => ({
    section: sec,
    items: steps
      .filter((s) => s.sectionId === sec.id)
      .sort((a, b) => a.orderingHint - b.orderingHint),
  }));

  // Auto-scroll the focused step into view when currentStepId changes
  // (e.g. Prev/Next nav, keyboard shortcut, or fresh-step insert).
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!currentStepId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-rail-step-id="${currentStepId}"]`,
    );
    if (el && scrollContainerRef.current) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentStepId]);

  const hasAnything = orphanSteps.length > 0 || sectionGroups.length > 0;

  return (
    <aside
      ref={scrollContainerRef}
      className="flex h-full flex-col gap-2 overflow-y-auto border-r border-line-subtle bg-surface px-2 py-3"
      aria-label="Procedure outline"
    >
      <div className="px-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          Outline
        </p>
        <p className="mt-0.5 text-[11px] text-ink-tertiary/80">
          {steps.length} step{steps.length === 1 ? '' : 's'} ·{' '}
          {sections.length} section{sections.length === 1 ? '' : 's'}
        </p>
      </div>

      {!hasAnything && (
        <div className="mx-2 mt-2 rounded-md border border-dashed border-line bg-surface-raised p-3 text-center">
          <p className="text-xs text-ink-tertiary">No steps yet.</p>
          <button
            type="button"
            onClick={() => void onAddStep(null)}
            disabled={bulkBusy}
            className="mt-2 inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            Add first step
          </button>
        </div>
      )}

      {/* Orphan steps (sectionId === null). Render under a synthetic
          "Ungrouped" header only when the procedure ALSO has sections —
          otherwise the procedure is "flat" and a label is just noise. */}
      {orphanSteps.length > 0 && (
        <RailGroup
          sectionTitle={sectionGroups.length > 0 ? 'Ungrouped' : null}
          steps={orphanSteps}
          currentStepId={currentStepId}
          onFocusStep={onFocusStep}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          dragId={dragId}
          dropTargetId={dropTargetId}
          onAddStep={() => void onAddStep(null)}
          onInsertSnippet={() => onInsertSnippet(null)}
          bulkBusy={bulkBusy}
        />
      )}

      {sectionGroups.map((g) => (
        <RailSection
          key={g.section.id}
          section={g.section}
          steps={g.items}
          currentStepId={currentStepId}
          onFocusStep={onFocusStep}
          onAddStep={() => void onAddStep(g.section.id)}
          onInsertSnippet={() => onInsertSnippet(g.section.id)}
          onRenameSection={(t) => void onRenameSection(g.section.id, t)}
          onDeleteSection={() => void onDeleteSection(g.section.id)}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          dragId={dragId}
          dropTargetId={dropTargetId}
          bulkBusy={bulkBusy}
        />
      ))}

      <div className="mt-1 px-1">
        <button
          type="button"
          onClick={() => void onAddSection()}
          disabled={bulkBusy}
          className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-line bg-surface px-2 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:text-accent disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add section
        </button>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// RailSection — one section with its inline-editable title, kebab menu,
// step rows, and trailing "+ Add step" affordance. Owns the title race
// guard so quick-typing across an autosave boundary doesn't drop chars.
// ---------------------------------------------------------------------------

function RailSection({
  section,
  steps,
  currentStepId,
  onFocusStep,
  onAddStep,
  onInsertSnippet,
  onRenameSection,
  onDeleteSection,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragId,
  dropTargetId,
  bulkBusy,
}: {
  section: AdminProcedureSection;
  steps: AdminProcedureStep[];
  currentStepId: string | null;
  onFocusStep: (stepId: string) => void;
  onAddStep: () => void;
  onInsertSnippet: () => void;
  onRenameSection: (nextTitle: string) => void;
  onDeleteSection: () => void;
  onDragStart: (stepId: string) => (e: React.DragEvent) => void;
  onDragOver: (stepId: string) => (e: React.DragEvent) => void;
  onDrop: (stepId: string) => (e: React.DragEvent) => Promise<void> | void;
  onDragEnd: () => void;
  dragId: string | null;
  dropTargetId: string | null;
  bulkBusy: boolean;
}) {
  // Same race-safe debounced rename pattern used in the List view's
  // SectionGroup. Without lastSentTitleRef the parent-sync useEffect
  // clobbers in-flight keystrokes when our own save echoes back.
  const [title, setTitle] = useState(section.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentTitleRef = useRef(section.title);
  const titleRef = useRef(title);
  const sectionTitleRef = useRef(section.title);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    sectionTitleRef.current = section.title;
    if (section.title !== lastSentTitleRef.current) {
      setTitle(section.title);
      lastSentTitleRef.current = section.title;
    }
  }, [section.title]);

  function onInput(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      titleTimer.current = null;
      const v = next.trim();
      if (v && v !== section.title) {
        lastSentTitleRef.current = v;
        onRenameSection(v);
      }
    }, 600);
  }

  // Flush on unmount — same pattern as List view's SectionGroup.
  useEffect(() => {
    return () => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current);
        titleTimer.current = null;
        const v = titleRef.current.trim();
        if (v && v !== sectionTitleRef.current) {
          lastSentTitleRef.current = v;
          onRenameSection(v);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <header className="flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand section' : 'Collapse section'}
          className="rounded p-0.5 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
        >
          {collapsed ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronUp className="size-3.5" />
          )}
        </button>
        <input
          type="text"
          value={title}
          onChange={(e) => onInput(e.target.value)}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold uppercase tracking-wider text-ink-secondary outline-none transition focus:border-line focus:bg-surface-raised focus:normal-case focus:tracking-normal focus:text-ink-primary"
          aria-label="Section title"
          placeholder="Section title"
        />
        <RailSectionKebab
          onAddStep={onAddStep}
          onInsertSnippet={onInsertSnippet}
          onDelete={onDeleteSection}
          disabled={bulkBusy}
        />
      </header>
      {!collapsed && (
        <>
          <ul className="flex flex-col gap-0.5">
            {steps.map((s, i) => (
              <RailStepRow
                key={s.id}
                step={s}
                index={i + 1}
                active={s.id === currentStepId}
                onFocus={() => onFocusStep(s.id)}
                onDragStart={onDragStart(s.id)}
                onDragOver={onDragOver(s.id)}
                onDrop={onDrop(s.id)}
                onDragEnd={onDragEnd}
                isDragging={dragId === s.id}
                isDropTarget={dropTargetId === s.id && dragId !== s.id}
                draggable={!bulkBusy}
              />
            ))}
          </ul>
          <div className="ml-4 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={onAddStep}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-elevated hover:text-accent disabled:opacity-50"
            >
              <Plus className="size-3" />
              Add step
            </button>
            <button
              type="button"
              onClick={onInsertSnippet}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-elevated hover:text-accent disabled:opacity-50"
              title="Insert a reusable snippet (LOTO, PPE briefing, etc.) — edits to the snippet propagate everywhere it's used."
            >
              <Puzzle className="size-3" />
              Snippet
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RailGroup — the orphan / "Ungrouped" row group (no section header).
// Lighter chrome than RailSection; just a label and the step rows.
// ---------------------------------------------------------------------------

function RailGroup({
  sectionTitle,
  steps,
  currentStepId,
  onFocusStep,
  onAddStep,
  onInsertSnippet,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragId,
  dropTargetId,
  bulkBusy,
}: {
  sectionTitle: string | null;
  steps: AdminProcedureStep[];
  currentStepId: string | null;
  onFocusStep: (stepId: string) => void;
  onAddStep: () => void;
  onInsertSnippet: () => void;
  onDragStart: (stepId: string) => (e: React.DragEvent) => void;
  onDragOver: (stepId: string) => (e: React.DragEvent) => void;
  onDrop: (stepId: string) => (e: React.DragEvent) => Promise<void> | void;
  onDragEnd: () => void;
  dragId: string | null;
  dropTargetId: string | null;
  bulkBusy: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {sectionTitle && (
        <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          {sectionTitle}
        </p>
      )}
      <ul className="flex flex-col gap-0.5">
        {steps.map((s, i) => (
          <RailStepRow
            key={s.id}
            step={s}
            index={i + 1}
            active={s.id === currentStepId}
            onFocus={() => onFocusStep(s.id)}
            onDragStart={onDragStart(s.id)}
            onDragOver={onDragOver(s.id)}
            onDrop={onDrop(s.id)}
            onDragEnd={onDragEnd}
            isDragging={dragId === s.id}
            isDropTarget={dropTargetId === s.id && dragId !== s.id}
            draggable={!bulkBusy}
          />
        ))}
      </ul>
      <div className="ml-4 flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={onAddStep}
          disabled={bulkBusy}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-elevated hover:text-accent disabled:opacity-50"
        >
          <Plus className="size-3" />
          Add step
        </button>
        <button
          type="button"
          onClick={onInsertSnippet}
          disabled={bulkBusy}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-elevated hover:text-accent disabled:opacity-50"
          title="Insert a reusable snippet (LOTO, PPE briefing, etc.) — edits to the snippet propagate everywhere it's used."
        >
          <Puzzle className="size-3" />
          Snippet
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RailStepRow — one row in the rail. Drag grip, numeric index, truncated
// title, quiet status pills (safety / 🎧 / 📷N). Active row gets the
// brand-accent tinted background.
// ---------------------------------------------------------------------------

function RailStepRow({
  step,
  index,
  active,
  onFocus,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDropTarget,
  draggable,
}: {
  step: AdminProcedureStep;
  index: number;
  active: boolean;
  onFocus: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => Promise<void> | void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
  draggable: boolean;
}) {
  const titlePreview = step.title.trim() || 'Untitled step';
  const hasVoiceover = !!step.audioUrl;
  const photoCount = (step.media ?? []).filter((m) => m.kind === 'image').length;

  return (
    <li
      data-rail-step-id={step.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => void onDrop(e)}
      onDragEnd={onDragEnd}
      data-dragging={isDragging || undefined}
      data-drop-target={isDropTarget || undefined}
      className={[
        'group flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1 transition',
        active
          ? 'border-accent/40 bg-accent/10'
          : 'border-transparent hover:bg-surface-raised',
        isDragging ? 'opacity-50' : '',
        isDropTarget ? 'ring-1 ring-accent/60' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onFocus();
        }
      }}
      title={titlePreview}
    >
      <span
        className="cursor-grab text-ink-tertiary/40 opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
        title="Drag to reorder"
      >
        <GripVertical className="size-3" />
      </span>
      <span
        className={[
          'font-mono text-[10px] tabular-nums shrink-0',
          active ? 'text-accent font-semibold' : 'text-ink-tertiary',
        ].join(' ')}
      >
        {String(index).padStart(2, '0')}
      </span>
      <span
        className={[
          'min-w-0 flex-1 truncate text-xs',
          active ? 'font-semibold text-ink-primary' : 'text-ink-secondary',
          !step.title.trim() ? 'italic' : '',
        ].join(' ')}
      >
        {titlePreview}
      </span>
      {step.safetyCritical && (
        <ShieldAlert
          className="size-3 shrink-0 text-signal-warn"
          aria-label="Safety-critical"
        />
      )}
      {photoCount > 0 && (
        <span
          className="shrink-0 text-[9px] tabular-nums text-ink-tertiary"
          title={`${photoCount} photo${photoCount === 1 ? '' : 's'}`}
        >
          📷{photoCount}
        </span>
      )}
      {hasVoiceover && (
        <span
          className="shrink-0 text-[9px] text-ink-tertiary"
          title="Voiceover attached"
        >
          🎧
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// RailSectionKebab — section-level kebab (⋮): delete section.
// Keeps the row uncluttered and parks the destructive action behind a
// click. "+ Add step" is its own button rather than in here because the
// affordance is too frequent to bury.
// ---------------------------------------------------------------------------

function RailSectionKebab({
  onAddStep,
  onInsertSnippet,
  onDelete,
  disabled,
}: {
  onAddStep: () => void;
  onInsertSnippet: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Section actions"
        className="rounded p-0.5 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary disabled:opacity-40"
        title="Section actions"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-md border border-line bg-surface-raised shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddStep();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink-primary transition hover:bg-surface-elevated"
          >
            <Plus className="size-3.5" /> Add step in section
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onInsertSnippet();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink-primary transition hover:bg-surface-elevated"
          >
            <Puzzle className="size-3.5" /> Insert snippet
          </button>
          <hr className="my-1 border-line-subtle" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-signal-fault transition hover:bg-signal-fault/10"
          >
            <Trash2 className="size-3.5" /> Delete section
          </button>
        </div>
      )}
    </div>
  );
}

// Re-export ListChecks for callers that want the same icon set.
export { ListChecks };
