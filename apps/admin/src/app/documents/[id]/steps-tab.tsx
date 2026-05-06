'use client';

// Steps tab — author the per-step content for a structured_procedure
// document. Mirrors sections-tab.tsx but for procedure_steps. Shows up
// only when doc.kind === 'structured_procedure' (gated in page.tsx).

import { useState } from 'react';
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  ListChecks,
  Pencil,
  Plus,
  Ruler,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  ErrorBanner,
  FullPageOverlay,
  PrimaryButton,
} from '@/components/form';
import { Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import {
  createProcedureStep,
  deleteProcedureStep,
  reorderProcedureSteps,
  setPartsForProcedureStep,
  updateProcedureStep,
  type AdminDocumentDetail,
  type AdminProcedureStep,
  type CreateProcedureStepInput,
  type ProcedureStepKind,
} from '@/lib/api';
import { ProcedureStepForm } from '@/components/procedure-step-editor/step-form';

export function StepsTab({
  doc,
  steps,
  onChanged,
}: {
  doc: AdminDocumentDetail;
  steps: AdminProcedureStep[];
  onChanged: () => Promise<void> | void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProcedureStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSourceMd, setShowSourceMd] = useState(false);
  const toast = useToast();

  function openCreate() {
    setEditing(null);
    setDrawerOpen(true);
  }
  function openEdit(s: AdminProcedureStep) {
    setEditing(s);
    setDrawerOpen(true);
  }

  async function onSave(input: CreateProcedureStepInput, partIds: string[]) {
    try {
      const saved = editing
        ? await updateProcedureStep(editing.id, input)
        : await createProcedureStep(doc.id, input);
      await setPartsForProcedureStep(saved.id, partIds);
      toast.success(editing ? 'Step updated' : 'Step created');
      setDrawerOpen(false);
      setEditing(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete(s: AdminProcedureStep) {
    if (!confirm(`Delete step "${s.title}"? This cannot be undone.`)) return;
    try {
      await deleteProcedureStep(s.id);
      toast.success('Step deleted');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onMoveStep(idx: number, dir: -1 | 1) {
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= steps.length) return;
    const next = [...steps];
    const tmp = next[idx]!;
    next[idx] = next[swapWith]!;
    next[swapWith] = tmp;
    try {
      await reorderProcedureSteps(
        doc.id,
        next.map((s) => s.id),
      );
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const hasSourceMarkdown = (doc.bodyMarkdown ?? '').trim().length > 0;
  const isEmpty = steps.length === 0;

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />

      {isEmpty && hasSourceMarkdown && (
        <div className="flex flex-col gap-2 rounded-md border border-signal-info/40 bg-signal-info/10 px-4 py-3 text-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-signal-info" />
            <div className="flex-1">
              <p className="font-medium text-signal-info">
                This procedure is currently authored as one block of markdown.
              </p>
              <p className="mt-0.5 text-ink-secondary">
                Author it as discrete steps to enable interactive runs in the
                PWA — techs get a checklist with photo / measurement evidence
                instead of a static page.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowSourceMd((v) => !v)}
            className="self-start text-xs text-signal-info hover:underline"
          >
            {showSourceMd ? 'Hide' : 'Show'} source markdown — copy passages as
            you author each step
          </button>
          {showSourceMd && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-signal-info/30 bg-surface-raised p-3 font-mono text-xs text-ink-primary">
              {doc.bodyMarkdown}
            </pre>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          Steps are the unit of execution. Each one becomes a card the tech taps
          through; required photos and measurements are enforced per-step.
        </p>
        <PrimaryButton type="button" onClick={openCreate}>
          <Plus className="size-4" /> Add step
        </PrimaryButton>
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised p-12 text-center">
          <p className="text-base font-semibold text-ink-primary">No steps yet</p>
          <p className="max-w-md text-sm text-ink-tertiary">
            Add steps to turn this procedure into an interactive checklist with
            evidence capture.
          </p>
          <PrimaryButton type="button" onClick={openCreate} className="mt-2">
            <Plus className="size-4" /> Add your first step
          </PrimaryButton>
        </div>
      ) : (
        <ul className="space-y-2">
          {steps.map((s, idx) => (
            <StepRow
              key={s.id}
              step={s}
              index={idx + 1}
              isFirst={idx === 0}
              isLast={idx === steps.length - 1}
              onEdit={() => openEdit(s)}
              onDelete={() => onDelete(s)}
              onMoveUp={() => onMoveStep(idx, -1)}
              onMoveDown={() => onMoveStep(idx, 1)}
            />
          ))}
        </ul>
      )}

      <FullPageOverlay
        title={editing ? `Edit step — ${editing.title}` : 'New procedure step'}
        subtitle={`${doc.title} · structured procedure`}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
      >
        <ProcedureStepForm
          editing={editing}
          onSave={onSave}
          onCancel={() => {
            setDrawerOpen(false);
            setEditing(null);
          }}
        />
      </FullPageOverlay>
    </div>
  );
}

function StepRow({
  step,
  index,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  step: AdminProcedureStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const KindIcon =
    step.kind === 'photo_required'
      ? Camera
      : step.kind === 'measurement_required'
        ? Ruler
        : step.kind === 'safety_check'
          ? ShieldAlert
          : ClipboardCheck;

  return (
    <li className="rounded-md border border-line-subtle bg-surface-raised p-4">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1">
          <span className="font-mono text-xs tabular-nums text-ink-tertiary">
            {String(index).padStart(2, '0')}
          </span>
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className="rounded p-0.5 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
            aria-label="Move up"
          >
            <ChevronUp className="size-4" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className="rounded p-0.5 text-ink-tertiary disabled:opacity-30 hover:bg-surface hover:text-ink-primary"
            aria-label="Move down"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
        <KindIcon className="mt-1 size-5 shrink-0 text-ink-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium text-ink-primary">{step.title}</p>
            <Pill>{step.kind.replace(/_/g, ' ')}</Pill>
            {step.safetyCritical && <Pill tone="warning">safety-critical</Pill>}
          </div>
          <p className="mt-1 font-mono text-xs text-ink-tertiary">
            {summariseEvidence(step)}
          </p>
          {step.bodyMarkdown && (
            <p className="mt-2 line-clamp-2 text-sm text-ink-secondary">
              {step.bodyMarkdown}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded p-1.5 text-ink-tertiary hover:bg-surface hover:text-ink-primary"
            aria-label="Edit"
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1.5 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
            aria-label="Delete"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
    </li>
  );
}

function summariseEvidence(step: AdminProcedureStep): string {
  const parts: string[] = [];
  if (step.requiresPhoto) {
    parts.push(`${step.minPhotoCount} photo${step.minPhotoCount === 1 ? '' : 's'}`);
  }
  if (step.measurementSpec) {
    const spec = step.measurementSpec;
    if (spec.kind === 'numeric') {
      const range =
        spec.min != null && spec.max != null
          ? `${spec.min}–${spec.max}`
          : spec.min != null
            ? `≥${spec.min}`
            : spec.max != null
              ? `≤${spec.max}`
              : spec.expected != null
                ? `target ${spec.expected}`
                : 'numeric';
      parts.push(`${spec.label}: ${range} ${spec.unit}`);
    } else if (spec.kind === 'pass_fail') {
      parts.push(`${spec.label}: pass/fail`);
    } else {
      parts.push(`${spec.label}: free text`);
    }
  }
  if (parts.length === 0) return 'No evidence required';
  return parts.join(' · ');
}

// Re-exported for callers that wire the icon next to the section row.
export { ListChecks };
