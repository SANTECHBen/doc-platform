'use client';

// InteractionForm — single form that renders the right config editor
// based on the interaction kind. Kept in one file because each per-kind
// editor is small (~20-40 LOC) and they share the prompt/weight wrapper.
//
// When editing existing interactions, the kind is fixed (kind changes
// would require migrating the config; for v1 the author deletes + re-
// creates instead).

import { useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import {
  Field,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  Textarea,
  TextInput,
} from '@/components/form';
import { SLIDE_INTERACTION_KIND_LABELS } from '@platform/shared';
import type {
  SlideInteractionDto,
  SlideInteractionKind,
} from '@/lib/slide-course-api';

interface InteractionFormProps {
  initial: SlideInteractionDto | null;
  initialKind?: SlideInteractionKind;
  onSave: (payload: {
    kind: SlideInteractionKind;
    prompt: string;
    config: Record<string, unknown>;
    weight: number;
    orderingHint: number;
  }) => Promise<void>;
  onCancel: () => void;
  defaultOrderingHint?: number;
}

export function InteractionForm(props: InteractionFormProps) {
  const { initial, initialKind, onSave, onCancel } = props;
  const kind: SlideInteractionKind = initial?.kind ?? initialKind ?? 'mcq';

  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [weight, setWeight] = useState(initial?.weight ?? 1);
  const [orderingHint, setOrderingHint] = useState(
    initial?.orderingHint ?? props.defaultOrderingHint ?? 0,
  );
  const [config, setConfig] = useState<Record<string, unknown>>(
    initial?.config ?? buildDefaultConfig(kind),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Validate locally for snappy feedback before sending to server.
  const localValid = useMemo(() => validateConfig(kind, config), [kind, config]);

  async function onSubmit() {
    if (!prompt.trim()) {
      setSubmitError('Prompt is required.');
      return;
    }
    if (localValid !== true) {
      setSubmitError(localValid);
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      await onSave({
        kind,
        prompt: prompt.trim(),
        config,
        weight: Number.isFinite(weight) ? weight : 1,
        orderingHint: Number.isFinite(orderingHint) ? orderingHint : 0,
      });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
          {initial ? 'Edit' : 'New'} · {SLIDE_INTERACTION_KIND_LABELS[kind]}
        </span>
        <GhostButton type="button" onClick={onCancel} aria-label="Cancel">
          <X className="size-3.5" />
        </GhostButton>
      </div>

      <Field label="Prompt" required>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="What should the learner do?"
          maxLength={2000}
        />
      </Field>

      {kind === 'mcq' && <McqEditor config={config} onChange={setConfig} />}
      {kind === 'true_false' && <TrueFalseEditor config={config} onChange={setConfig} />}
      {kind === 'drag_match' && <DragMatchEditor config={config} onChange={setConfig} />}
      {kind === 'short_answer_ai' && (
        <ShortAnswerAiEditor config={config} onChange={setConfig} />
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Weight" hint="Scoring weight relative to other interactions.">
          <TextInput
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={weight}
            onChange={(e) => setWeight(Number(e.target.value))}
          />
        </Field>
        <Field label="Order">
          <TextInput
            type="number"
            value={orderingHint}
            onChange={(e) => setOrderingHint(Number(e.target.value))}
          />
        </Field>
      </div>

      {submitError && (
        <p className="rounded border border-signal-fault/40 bg-signal-fault/10 px-2 py-1 text-xs text-signal-fault">
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <SecondaryButton type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </SecondaryButton>
        <PrimaryButton type="button" onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Add interaction'}
        </PrimaryButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-kind editors
// ---------------------------------------------------------------------------

function McqEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const options = (config.options as string[]) ?? [];
  const correctIndex = (config.correctIndex as number) ?? 0;
  const explanation = (config.explanation as string | undefined) ?? '';

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-tertiary">Choose the one correct option.</p>
      {options.map((opt, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="radio"
            name="mcq-correct"
            checked={i === correctIndex}
            onChange={() => onChange({ ...config, correctIndex: i })}
          />
          <TextInput
            className="flex-1"
            value={opt}
            onChange={(e) => {
              const next = [...options];
              next[i] = e.target.value;
              onChange({ ...config, options: next });
            }}
            placeholder={`Option ${i + 1}`}
          />
          <GhostButton
            type="button"
            disabled={options.length <= 2}
            onClick={() => {
              const next = options.filter((_, j) => j !== i);
              const newCorrect = correctIndex >= next.length ? next.length - 1 : correctIndex;
              onChange({ ...config, options: next, correctIndex: Math.max(0, newCorrect) });
            }}
            aria-label="Remove option"
          >
            <Trash2 className="size-3.5" />
          </GhostButton>
        </div>
      ))}
      {options.length < 8 && (
        <SecondaryButton
          type="button"
          onClick={() => onChange({ ...config, options: [...options, ''] })}
        >
          <Plus className="size-3.5" /> Add option
        </SecondaryButton>
      )}
      <Field label="Explanation (shown after answer)">
        <Textarea
          value={explanation}
          rows={2}
          onChange={(e) => onChange({ ...config, explanation: e.target.value || undefined })}
          placeholder="Optional: why this is the right answer."
          maxLength={2000}
        />
      </Field>
    </div>
  );
}

function TrueFalseEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const correct = (config.correctAnswer as boolean) ?? true;
  const explanation = (config.explanation as string | undefined) ?? '';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink-secondary">Correct answer:</span>
        <button
          type="button"
          onClick={() => onChange({ ...config, correctAnswer: true })}
          className={[
            'rounded border px-3 py-1 text-sm transition',
            correct ? 'border-accent bg-accent/15 text-ink-primary' : 'border-line',
          ].join(' ')}
        >
          True
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...config, correctAnswer: false })}
          className={[
            'rounded border px-3 py-1 text-sm transition',
            !correct ? 'border-accent bg-accent/15 text-ink-primary' : 'border-line',
          ].join(' ')}
        >
          False
        </button>
      </div>
      <Field label="Explanation (shown after answer)">
        <Textarea
          value={explanation}
          rows={2}
          onChange={(e) => onChange({ ...config, explanation: e.target.value || undefined })}
          maxLength={2000}
        />
      </Field>
    </div>
  );
}

function DragMatchEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const pairs = (config.pairs as Array<{ left: string; right: string }>) ?? [];
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-tertiary">
        Each row is one pair. The learner sees the left labels and drags the
        right values to match.
      </p>
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <TextInput
            className="flex-1"
            value={p.left}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...p, left: e.target.value };
              onChange({ ...config, pairs: next });
            }}
            placeholder="Term / label"
          />
          <span className="text-xs text-ink-tertiary">↔</span>
          <TextInput
            className="flex-1"
            value={p.right}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...p, right: e.target.value };
              onChange({ ...config, pairs: next });
            }}
            placeholder="Matching definition"
          />
          <GhostButton
            type="button"
            disabled={pairs.length <= 2}
            onClick={() => onChange({ ...config, pairs: pairs.filter((_, j) => j !== i) })}
            aria-label="Remove pair"
          >
            <Trash2 className="size-3.5" />
          </GhostButton>
        </div>
      ))}
      {pairs.length < 8 && (
        <SecondaryButton
          type="button"
          onClick={() => onChange({ ...config, pairs: [...pairs, { left: '', right: '' }] })}
        >
          <Plus className="size-3.5" /> Add pair
        </SecondaryButton>
      )}
    </div>
  );
}

function ShortAnswerAiEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const rubric = (config.rubric as string) ?? '';
  const examples = (config.exampleAcceptable as string[]) ?? [];
  const passThreshold = (config.passThreshold as number) ?? 0.7;
  return (
    <div className="space-y-2">
      <Field
        label="Rubric"
        hint="Describe what a correct answer must include. The AI grader follows this."
        required
      >
        <Textarea
          value={rubric}
          rows={4}
          onChange={(e) => onChange({ ...config, rubric: e.target.value })}
          maxLength={4000}
          placeholder="A correct answer mentions both the hazard and the mitigation, and references the specific tool used."
        />
      </Field>
      <Field
        label="Example acceptable answers (optional)"
        hint="Up to 5. Helps the AI calibrate its judgment."
      >
        <div className="space-y-2">
          {examples.map((ex, i) => (
            <div key={i} className="flex items-start gap-2">
              <Textarea
                className="flex-1"
                value={ex}
                rows={2}
                onChange={(e) => {
                  const next = [...examples];
                  next[i] = e.target.value;
                  onChange({ ...config, exampleAcceptable: next });
                }}
                maxLength={2000}
              />
              <GhostButton
                type="button"
                onClick={() =>
                  onChange({
                    ...config,
                    exampleAcceptable: examples.filter((_, j) => j !== i),
                  })
                }
                aria-label="Remove example"
              >
                <Trash2 className="size-3.5" />
              </GhostButton>
            </div>
          ))}
          {examples.length < 5 && (
            <SecondaryButton
              type="button"
              onClick={() =>
                onChange({ ...config, exampleAcceptable: [...examples, ''] })
              }
            >
              <Plus className="size-3.5" /> Add example
            </SecondaryButton>
          )}
        </div>
      </Field>
      <Field label={`Pass threshold (${Math.round(passThreshold * 100)}%)`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={passThreshold}
          onChange={(e) => onChange({ ...config, passThreshold: Number(e.target.value) })}
          className="w-full"
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default configs + local validation
// ---------------------------------------------------------------------------

export function buildDefaultConfig(kind: SlideInteractionKind): Record<string, unknown> {
  if (kind === 'mcq') {
    return { options: ['', '', '', ''], correctIndex: 0 };
  }
  if (kind === 'true_false') {
    return { correctAnswer: true };
  }
  if (kind === 'drag_match') {
    return {
      pairs: [
        { left: '', right: '' },
        { left: '', right: '' },
      ],
    };
  }
  return { rubric: '', exampleAcceptable: [], passThreshold: 0.7 };
}

function validateConfig(
  kind: SlideInteractionKind,
  config: Record<string, unknown>,
): true | string {
  if (kind === 'mcq') {
    const opts = config.options as string[] | undefined;
    if (!opts || opts.length < 2) return 'Need at least 2 options.';
    if (opts.some((o) => !o.trim())) return 'All option labels must be non-empty.';
    const ci = config.correctIndex as number;
    if (typeof ci !== 'number' || ci < 0 || ci >= opts.length)
      return 'Select the correct option.';
    return true;
  }
  if (kind === 'true_false') {
    if (typeof config.correctAnswer !== 'boolean') return 'Pick true or false.';
    return true;
  }
  if (kind === 'drag_match') {
    const pairs = config.pairs as Array<{ left: string; right: string }> | undefined;
    if (!pairs || pairs.length < 2) return 'Need at least 2 pairs.';
    if (pairs.some((p) => !p.left.trim() || !p.right.trim()))
      return 'Both sides of every pair are required.';
    if (new Set(pairs.map((p) => p.left)).size !== pairs.length)
      return 'Left-side labels must be unique.';
    return true;
  }
  const rubric = (config.rubric as string) ?? '';
  if (rubric.trim().length < 10) return 'Rubric must be at least 10 characters.';
  return true;
}

