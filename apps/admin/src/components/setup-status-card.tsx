'use client';

// Per-tenant Setup Status card. Rendered at the top of /tenants/[id] to give
// admins a single overview of "what's left to do for this customer". Pure
// presentation — all logic lives in lib/setup-status.ts.
//
// Visual language mirrors the dashboard's SetupChecklist: rounded card,
// progress bar, icon-chip per row. Rows differ from the dashboard's:
// each row here represents a step that may be done / pending / blocked /
// optional, and we surface a sub-detail line ("1 site • Memphis DC") so
// the admin doesn't have to drill in to know what's already there.

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import {
  ArrowRight,
  Boxes,
  Building2,
  Check,
  CircleDashed,
  FileCheck,
  Lock,
  MapPin,
  QrCode,
  Tag,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { SetupStatus, SetupStep, SetupStepId } from '@/lib/setup-status';

const STEP_ICON: Record<SetupStepId, LucideIcon> = {
  organization: Building2,
  site: MapPin,
  asset_model: Boxes,
  parts_bom: Wrench,
  content_published: FileCheck,
  asset_instance: Tag,
  qr_code: QrCode,
};

interface Props {
  status: SetupStatus;
  /** When set, briefly highlight the matching row (used after Save & continue). */
  highlightStepId?: SetupStepId | null;
  /** Called when admin clicks an inline (anchor-only) step like "Add a site"
   *  — caller scrolls to the right section on the page. */
  onScrollTo?: (anchor: string) => void;
}

export function SetupStatusCard({ status, highlightStepId, onScrollTo }: Props) {
  const { steps, completion, nextStep } = status;
  const allDone = completion.percent === 100 && nextStep === null;

  return (
    <section className="rounded-md border border-line bg-surface-raised p-5 md:p-6 mb-6">
      <header className="mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink-primary">Setup status</h2>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {allDone
              ? 'This tenant is fully set up. Everything below is ready for the field.'
              : nextStep
              ? `Next: ${nextStep.label}.`
              : 'Setup walkthrough.'}
          </p>
        </div>
        <div className="flex items-center gap-3 md:shrink-0">
          <div className="relative h-1.5 w-32 overflow-hidden rounded-full bg-surface-inset">
            <div
              className="absolute inset-y-0 left-0 bg-brand transition-[width] duration-500"
              style={{ width: `${completion.percent}%` }}
            />
          </div>
          <span className="tnum mono text-xs text-ink-tertiary">
            {completion.done}/{completion.total} • {completion.percent}%
          </span>
        </div>
      </header>

      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            isNext={!allDone && nextStep?.id === step.id}
            highlight={highlightStepId === step.id}
            onScrollTo={onScrollTo}
          />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  isNext,
  highlight,
  onScrollTo,
}: {
  step: SetupStep;
  isNext: boolean;
  highlight: boolean;
  onScrollTo?: (anchor: string) => void;
}) {
  const Icon = STEP_ICON[step.id];
  const rowRef = useRef<HTMLLIElement>(null);

  // Briefly pulse the row when it matches highlightStepId (e.g. after a
  // "Save & continue setup" redirect lands the admin back here with
  // ?step=<this>).
  useEffect(() => {
    if (!highlight || !rowRef.current) return;
    rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    rowRef.current.classList.add('ring-2', 'ring-brand', 'ring-offset-2');
    const t = setTimeout(() => {
      rowRef.current?.classList.remove('ring-2', 'ring-brand', 'ring-offset-2');
    }, 1500);
    return () => clearTimeout(t);
  }, [highlight]);

  const rowStyle = isNext
    ? ({ borderColor: 'rgb(var(--brand) / 0.45)' } as const)
    : undefined;

  const isDone = step.status === 'done';
  const isBlocked = step.status === 'blocked';
  const isOptional = step.status === 'optional_pending';

  // The row is a Link when continueHref is set, a button when only an
  // anchor is provided (scroll-to inline section), and a plain div for
  // done/blocked rows.
  const rowChildren = (
    <>
      <div
        className={`icon-chip ${isDone ? 'icon-chip-ok' : isBlocked ? 'icon-chip-neutral opacity-60' : isNext ? '' : 'icon-chip-neutral'}`}
      >
        {isDone ? (
          <Check size={16} strokeWidth={2.5} />
        ) : isBlocked ? (
          <Lock size={14} strokeWidth={2} />
        ) : isOptional ? (
          <CircleDashed size={16} strokeWidth={2} />
        ) : (
          <Icon size={16} strokeWidth={2} />
        )}
      </div>
      <div className="list-row-body">
        <div
          className={`list-row-title flex items-center gap-2 ${
            isDone ? 'line-through decoration-ink-tertiary' : ''
          }`}
        >
          <span>{step.label}</span>
          {isOptional && (
            <span className="rounded bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
              optional
            </span>
          )}
          {isBlocked && step.blockedReason && (
            <span className="rounded bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
              {step.blockedReason}
            </span>
          )}
        </div>
        {step.detail && (
          <div className={`list-row-desc ${isBlocked ? 'opacity-60' : ''}`}>{step.detail}</div>
        )}
      </div>
      {!isDone && !isBlocked && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-brand group-hover:gap-2 transition-all">
          {isNext ? 'Continue' : 'Go'}
          <ArrowRight size={14} strokeWidth={2} />
        </span>
      )}
    </>
  );

  // 1) Done or blocked: render as a plain non-interactive row.
  if (isDone || isBlocked) {
    return (
      <li
        ref={rowRef}
        className={`list-row ${isDone ? 'opacity-60' : ''}`}
        style={rowStyle}
      >
        {rowChildren}
      </li>
    );
  }

  // 2) Has a continueHref: route off-page to a list page with ?continue=<orgId>.
  if (step.continueHref) {
    return (
      <li ref={rowRef}>
        <Link href={step.continueHref} className="list-row group" style={rowStyle}>
          {rowChildren}
        </Link>
      </li>
    );
  }

  // 3) Inline step (organization/site) — scroll to anchor section.
  if (step.anchor && onScrollTo) {
    return (
      <li ref={rowRef}>
        <button
          type="button"
          onClick={() => onScrollTo(step.anchor!)}
          className="list-row group w-full text-left"
          style={rowStyle}
        >
          {rowChildren}
        </button>
      </li>
    );
  }

  // 4) Fallback: just render as plain row (shouldn't happen with proper data).
  return (
    <li ref={rowRef} className="list-row" style={rowStyle}>
      {rowChildren}
    </li>
  );
}
