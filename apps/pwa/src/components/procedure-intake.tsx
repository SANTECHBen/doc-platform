'use client';

// ProcedureIntake — shared "what kind / what's the title" intake the
// PWA presents BEFORE both field-authoring flows:
//
//   * ProcedureDocWizard       — manual step-by-step capture
//   * VideoSubmission          — AI walkthrough (record video, drafter
//                                slices it into steps)
//
// The two flows used to diverge here: the manual wizard had a category
// picker + title prompt as its first two screens, and the AI walkthrough
// jumped straight to the camera-coach screen with the title field
// nested deeper in the capture form. Same metadata, two different
// presentations. This component is the canonical version of those two
// screens; both flows mount it as their entrypoint, and the only thing
// each wizard sees from intake is a single onCommit(category, title)
// callback when the tech finishes.
//
// Why a shared component (vs duplicating the two screens):
//   1. The four AuthoredProcedureCategory values are identical between
//      flows — both end up writing to the same enum on the server.
//   2. Visual consistency: techs hop between flows during a long session
//      and we don't want the picker chrome to subtly shift.
//   3. Single source of truth for the description copy each category
//      gets in the picker. Edits propagate instantly.
//
// Lifecycle:
//   * Parent decides when to mount us. We own the two-screen step state
//     internally (category → title); parent gets one onCommit when we
//     finish.
//   * Back from the category screen exits the whole intake — we call
//     onCancel so the parent can close the flow. Back from the title
//     screen returns to category internally.

import { useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  RotateCcw,
  ShieldAlert,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { MicButton } from '@/components/voice-input';
import type { AuthoredProcedureCategory } from '@/lib/api';

const CATEGORY_OPTIONS: Array<{
  key: AuthoredProcedureCategory;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    key: 'preventive_maintenance',
    label: 'Preventive maintenance',
    description: 'Inspections, lube, calibration, scheduled checks.',
    icon: ListChecks,
  },
  {
    key: 'troubleshooting',
    label: 'Troubleshooting',
    description: 'Diagnosing a symptom, fault, or alarm.',
    icon: ShieldAlert,
  },
  {
    key: 'removal_replacement',
    label: 'Removal & Replacement',
    description: 'Swapping a part or assembly out.',
    icon: RotateCcw,
  },
  {
    key: 'walkthrough',
    label: 'Walkthrough',
    description: 'Anything else — orientation, demos, one-offs.',
    icon: Wrench,
  },
];

interface Props {
  /** Small uppercase kicker rendered above the shell title — e.g.
   *  "DOCUMENT A PROCEDURE" for the manual wizard or "AI WALKTHROUGH"
   *  for the video submission. Lets each flow brand the intake while
   *  the structure stays identical. */
  kicker: string;
  /** Main title inside the shell. Usually mirrors the kicker but
   *  written in Title Case. */
  title: string;
  /** Total step count to display in "Step X of N" — usually 3 (intake
   *  category, intake title, then the flow's own capture step). The
   *  intake itself only renders steps 1 and 2; the parent flow renders
   *  step N. */
  totalSteps?: number;
  /** Pre-fill when the tech is editing intake (e.g. came back from
   *  capture). Both fields can come in as null/empty for first-mount. */
  initialCategory?: AuthoredProcedureCategory | null;
  initialTitle?: string;
  /** Cancel the whole intake (and its parent flow). Fires on the back
   *  arrow from the category screen, or the X button on either screen. */
  onCancel: () => void;
  /** Tech finished intake — commit the (category, title) to the parent
   *  so it can transition into the capture step. */
  onCommit: (input: {
    category: AuthoredProcedureCategory;
    title: string;
  }) => void;
}

export function ProcedureIntake({
  kicker,
  title,
  totalSteps = 3,
  initialCategory,
  initialTitle,
  onCancel,
  onCommit,
}: Props) {
  const [phase, setPhase] = useState<'category' | 'title'>(
    // If the parent re-mounts intake mid-flow (e.g. tech came back from
    // capture to edit metadata), start on whichever screen is empty.
    initialCategory && !initialTitle ? 'title' : 'category',
  );
  const [category, setCategory] = useState<AuthoredProcedureCategory | null>(
    initialCategory ?? null,
  );
  const [text, setText] = useState<string>(initialTitle ?? '');

  if (phase === 'category') {
    return (
      <Shell kicker={kicker} title={title} onBack={onCancel} onClose={onCancel}>
        <div className="flex flex-1 flex-col items-center gap-6 px-6 pb-8 pt-2">
          <div className="w-full max-w-md text-center">
            <p className="caption mb-2">Step 1 of {totalSteps}</p>
            <h2 className="text-2xl font-bold text-ink-primary">
              What kind of procedure?
            </h2>
            <p className="mt-2 text-sm text-ink-tertiary">
              This decides where the procedure shows up in Maintenance.
            </p>
          </div>
          <div className="w-full max-w-md flex flex-col gap-2.5">
            {CATEGORY_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = category === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setCategory(opt.key)}
                  aria-pressed={active}
                  className="category-pick-card"
                  data-active={active}
                >
                  <span className="category-pick-icon" aria-hidden>
                    <Icon size={22} strokeWidth={2} />
                  </span>
                  <span className="category-pick-text">
                    <span className="category-pick-label">{opt.label}</span>
                    <span className="category-pick-description">
                      {opt.description}
                    </span>
                  </span>
                  <span className="category-pick-check" aria-hidden>
                    {active && <Check size={18} strokeWidth={2.5} />}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setPhase('title')}
            disabled={!category}
            className="btn btn-primary btn-lg w-full max-w-md"
          >
            Next <ChevronRight size={18} strokeWidth={2} />
          </button>
        </div>
      </Shell>
    );
  }

  // phase === 'title'
  const categoryLabel = category
    ? CATEGORY_OPTIONS.find((c) => c.key === category)?.label ?? null
    : null;
  const canAdvance = text.trim().length > 0;
  return (
    <Shell
      kicker={kicker}
      title={title}
      onBack={() => setPhase('category')}
      onClose={onCancel}
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-12">
        <div className="w-full max-w-md">
          <p className="caption mb-3 text-center">
            Step 2 of {totalSteps}
            {categoryLabel ? ` · ${categoryLabel}` : ''}
          </p>
          <h2 className="text-center text-2xl font-bold text-ink-primary">
            What procedure are you documenting?
          </h2>
          <p className="mt-2 text-center text-sm text-ink-tertiary">
            Replace bearing assembly · Lubricate gearbox · Calibrate drum
          </p>
          <div className="mt-6 flex items-center gap-2">
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a title, or tap the mic"
              className="flex-1 rounded-md border border-line bg-surface-raised p-4 text-lg font-medium"
              autoFocus
            />
            <MicButton
              size="md"
              appendMode={false}
              onTranscript={(t) => setText(t)}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!category || !canAdvance) return;
            onCommit({ category, title: text.trim() });
          }}
          disabled={!canAdvance || !category}
          className="btn btn-primary btn-lg w-full max-w-md"
        >
          Next <ChevronRight size={18} strokeWidth={2} />
        </button>
      </div>
    </Shell>
  );
}

// Local copy of the wizard's FullScreenShell chrome — same DOM structure
// + classes so the visual treatment matches. Kept local rather than
// imported from procedure-doc-wizard to avoid cross-module coupling on
// what is fundamentally just a div with a top bar.
function Shell({
  kicker,
  title,
  onBack,
  onClose,
  children,
}: {
  kicker: string;
  title: string;
  onBack: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="doc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header className="doc-overlay-bar">
        <button
          type="button"
          onClick={onBack}
          className="app-topbar-btn"
          aria-label="Back"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="doc-overlay-title">
          <span className="caption">{kicker}</span>
          <h2 className="truncate text-base font-semibold">{title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="app-topbar-btn"
          aria-label="Cancel"
        >
          <X size={20} strokeWidth={2} />
        </button>
      </header>
      {children}
    </div>
  );
}
