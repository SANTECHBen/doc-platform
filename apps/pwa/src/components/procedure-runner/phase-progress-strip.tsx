'use client';

// PhaseProgressStrip — horizontal multi-segment progress indicator,
// one segment per authored section. Matches the visual idiom in
// progress.png:
//
//   SAFETY         PREP           REMOVAL        REPLACE        VERIFY
//   ━━━━━━━━━      ━━━━━━━━━      ━━━━━━━━━      ━━━━━━━━━      ━━━━━━━━━
//   █████████░    █████████░    ███░░░░░░░░    ░░░░░░░░░░░    ░░░░░░░░░░░
//
// Per-segment:
//   * Label = section title in uppercase. Falls back to the section's
//     category name when the title is empty (rare).
//   * Color = section.category.color, defaulting to the brand accent
//     when the section is uncategorized.
//   * Fill = completed / total within that section. Skipped completions
//     also count as "advanced past" — same convention as the step strip.
//   * Active segment (the one containing the current step) gets a
//     stronger text color and brighter fill saturation.
//   * Tap = jump to the first step of that section.
//
// Orphan steps (sectionId === null) get a synthetic leading segment
// labeled "Steps" so they're never invisible on a procedure that mixes
// sectioned + ungrouped steps. Hidden when no orphans exist (the common
// case for new authoring).

import { useMemo } from 'react';
import type {
  ProcedureSectionDto,
  ProcedureStepCompletionDto,
  ProcedureStepDto,
} from '@/lib/api';
import { CategoryIcon } from './category-icon';

interface Props {
  sections: ProcedureSectionDto[];
  steps: ProcedureStepDto[];
  completions: ProcedureStepCompletionDto[];
  currentStepIndex: number;
  /** Called with the index (into the linearized steps array) the strip
   *  wants to jump to. The runner uses this to advance currentStepIndex. */
  onJumpToStepIndex: (i: number) => void;
}

interface Phase {
  /** Section id, or null for the orphan synthetic group. */
  key: string | null;
  label: string;
  /** Hex color (drives the fill). */
  color: string;
  /** Optional Lucide icon name. */
  icon: string | null;
  /** Index range into the linearized steps array — [start, end). */
  start: number;
  end: number;
  /** Number of steps completed or skipped within this phase. */
  done: number;
  /** Whether the current step lives in this phase. */
  isActive: boolean;
}

const DEFAULT_PHASE_COLOR = '#2563EB'; // brand-ish; matches the neutral accent.

export function PhaseProgressStrip({
  sections,
  steps,
  completions,
  currentStepIndex,
  onJumpToStepIndex,
}: Props) {
  const phases = useMemo<Phase[]>(() => {
    if (steps.length === 0) return [];
    const completedIds = new Set(completions.map((c) => c.stepId));
    // Group consecutive runs of steps by sectionId. The runner already
    // sorts steps in (section.orderingHint, step.orderingHint) order,
    // so a single linear pass is enough to derive the phase boundaries.
    const out: Phase[] = [];
    let i = 0;
    const sectionMap = new Map(sections.map((s) => [s.id, s]));
    while (i < steps.length) {
      const startIdx = i;
      const startStep = steps[startIdx]!;
      const currentSecId = startStep.sectionId;
      let j = i + 1;
      while (j < steps.length && steps[j]!.sectionId === currentSecId) j += 1;
      // Resolve label + color from the matching section row (or the
      // orphan-synthetic fallback).
      const sec = currentSecId ? sectionMap.get(currentSecId) : null;
      const label = sec
        ? sec.title || sec.category?.name || 'Steps'
        : 'Steps';
      const color = sec?.category?.color ?? DEFAULT_PHASE_COLOR;
      const icon = sec?.category?.icon ?? null;
      let done = 0;
      for (let k = startIdx; k < j; k += 1) {
        if (completedIds.has(steps[k]!.id)) done += 1;
      }
      const isActive = currentStepIndex >= startIdx && currentStepIndex < j;
      out.push({
        key: currentSecId,
        label,
        color,
        icon,
        start: startIdx,
        end: j,
        done,
        isActive,
      });
      i = j;
    }
    return out;
  }, [sections, steps, completions, currentStepIndex]);

  if (phases.length === 0) return null;

  return (
    <nav
      aria-label="Procedure phases"
      className="flex shrink-0 items-stretch gap-2 overflow-x-auto border-b border-line bg-surface-elevated px-3 py-2"
    >
      {phases.map((p) => {
        const total = p.end - p.start;
        const pct = total > 0 ? Math.round((p.done / total) * 100) : 0;
        return (
          <button
            key={p.key ?? '__orphans__'}
            type="button"
            onClick={() => onJumpToStepIndex(p.start)}
            // Stay tight on narrow viewports — phases scroll horizontally
            // rather than crush.
            className="group flex min-w-[8rem] flex-1 flex-col items-stretch gap-1 text-left"
            aria-label={`${p.label} — ${p.done} of ${total} done${p.isActive ? ', current phase' : ''}`}
            aria-current={p.isActive ? 'step' : undefined}
          >
            <span
              className={[
                'flex items-center gap-1 truncate text-[11px] font-semibold uppercase tracking-wider transition',
                p.isActive
                  ? 'text-ink-primary'
                  : 'text-ink-tertiary group-hover:text-ink-secondary',
              ].join(' ')}
              style={p.isActive ? { color: p.color } : undefined}
            >
              <CategoryIcon name={p.icon} size={12} strokeWidth={2.25} />
              {p.label}
            </span>
            <span
              className="relative block h-1.5 w-full overflow-hidden rounded-full bg-line/40"
              aria-hidden
            >
              <span
                className="absolute inset-y-0 left-0 transition-[width] duration-300"
                style={{
                  width: `${pct}%`,
                  // Active phase uses the full color; inactive phases
                  // are de-saturated by the wrapper opacity below.
                  backgroundColor: p.color,
                  opacity: p.isActive ? 1 : 0.6,
                }}
              />
            </span>
          </button>
        );
      })}
    </nav>
  );
}
