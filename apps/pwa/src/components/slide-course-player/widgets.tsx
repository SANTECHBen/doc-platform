'use client';

// Player-side widgets for each interaction kind. Each widget takes:
//   interaction: the sanitized interaction (no correct answer)
//   priorResult: any previously-submitted answer's reveal payload + score
//   busy:        true while a submit is in flight
//   onSubmit:    called with the kind-specific answer payload
//
// Each widget locks itself after a passing submission and shows the
// reveal payload (correct answer / explanation / AI rationale) inline.
// On a failing answer, the widget allows another try.

import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Send } from 'lucide-react';
import type {
  AnswerResult,
  PlayerInteraction,
} from '@/lib/slide-course-api';

export interface WidgetProps {
  interaction: PlayerInteraction;
  priorResult: AnswerResult | null;
  busy: boolean;
  onSubmit: (answer: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// MCQ
// ---------------------------------------------------------------------------

export function McqWidget({ interaction, priorResult, busy, onSubmit }: WidgetProps) {
  const options = (interaction.config.options as string[]) ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const locked = priorResult?.passed === true;
  const correctIndex = priorResult?.reveal?.correctIndex as number | undefined;
  const explanation = priorResult?.reveal?.explanation as string | undefined;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{interaction.prompt}</p>
      <ul className="space-y-2">
        {options.map((opt, i) => {
          const chosen = picked === i;
          const isCorrect = correctIndex === i;
          const showResult = priorResult !== null;
          return (
            <li key={i}>
              <button
                type="button"
                disabled={busy || locked}
                onClick={() => setPicked(i)}
                className={[
                  'flex w-full items-start gap-2 rounded border px-3 py-2 text-left text-sm transition',
                  showResult && isCorrect
                    ? 'border-green-500 bg-green-500/10'
                    : showResult && chosen && !isCorrect
                      ? 'border-red-500 bg-red-500/10'
                      : chosen
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-line bg-surface',
                ].join(' ')}
              >
                <span className="font-mono text-xs">{String.fromCharCode(65 + i)}.</span>
                <span className="flex-1">{opt}</span>
                {showResult && isCorrect && <CheckCircle2 className="size-4 text-green-600" />}
              </button>
            </li>
          );
        })}
      </ul>
      {explanation && (
        <p className="rounded border border-line bg-surface-raised p-2 text-xs text-ink-secondary">
          {explanation}
        </p>
      )}
      {!locked && (
        <button
          type="button"
          disabled={busy || picked === null}
          onClick={() => picked !== null && onSubmit({ selectedIndex: picked })}
          className="btn btn-primary w-full"
        >
          {busy ? 'Submitting…' : priorResult ? 'Try again' : 'Submit'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// True / false
// ---------------------------------------------------------------------------

export function TrueFalseWidget({ interaction, priorResult, busy, onSubmit }: WidgetProps) {
  const locked = priorResult?.passed === true;
  const correctAnswer = priorResult?.reveal?.correctAnswer as boolean | undefined;
  const explanation = priorResult?.reveal?.explanation as string | undefined;
  // Local pick state — surfaces "red" feedback after a wrong guess.
  const [priorPick, setPriorPick] = useState<boolean | null>(null);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{interaction.prompt}</p>
      <div className="grid grid-cols-2 gap-2">
        {[true, false].map((v) => {
          const chosen = priorPick === v;
          const isCorrect = correctAnswer === v;
          const showResult = priorResult !== null;
          return (
            <button
              key={String(v)}
              type="button"
              disabled={busy || locked}
              onClick={() => {
                setPriorPick(v);
                void onSubmit({ answer: v });
              }}
              className={[
                'rounded border px-4 py-3 text-sm font-medium transition',
                showResult && isCorrect
                  ? 'border-green-500 bg-green-500/10'
                  : showResult && chosen && !isCorrect
                    ? 'border-red-500 bg-red-500/10'
                    : 'border-line bg-surface hover:border-blue-500',
              ].join(' ')}
            >
              {v ? 'True' : 'False'}
            </button>
          );
        })}
      </div>
      {explanation && (
        <p className="rounded border border-line bg-surface-raised p-2 text-xs text-ink-secondary">
          {explanation}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag-match — implemented as tap-to-pair on mobile (drag is awkward
// on touch). The learner taps a left label, then taps the right value
// they want to assign to it. Tapping a row that's already assigned
// clears the assignment. Submit grades the full mapping at once.
// ---------------------------------------------------------------------------

export function DragMatchWidget({ interaction, priorResult, busy, onSubmit }: WidgetProps) {
  const lefts = (interaction.config.lefts as string[]) ?? [];
  const rights = (interaction.config.rights as string[]) ?? [];
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [pickedLeft, setPickedLeft] = useState<string | null>(null);
  const locked = priorResult?.passed === true;
  const correctMapping = priorResult?.reveal?.correctMapping as
    | Record<string, string>
    | undefined;

  function pickRight(rightValue: string) {
    if (!pickedLeft) return;
    setMapping((m) => ({ ...m, [pickedLeft]: rightValue }));
    setPickedLeft(null);
  }
  function clearLeft(leftLabel: string) {
    setMapping((m) => {
      const next = { ...m };
      delete next[leftLabel];
      return next;
    });
  }
  const usedRights = new Set(Object.values(mapping));
  const fullyMapped = lefts.every((l) => mapping[l]);

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{interaction.prompt}</p>
      <p className="text-xs text-ink-tertiary">
        Tap a label, then tap its matching value. Tap an assigned label to
        clear it.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <ul className="space-y-1.5">
          {lefts.map((l) => {
            const chosen = pickedLeft === l;
            const value = mapping[l];
            const isCorrect = correctMapping?.[l] === value;
            return (
              <li key={l}>
                <button
                  type="button"
                  disabled={busy || locked}
                  onClick={() => (value ? clearLeft(l) : setPickedLeft(l))}
                  className={[
                    'flex w-full flex-col items-start gap-0.5 rounded border px-2 py-1.5 text-left text-sm',
                    chosen
                      ? 'border-blue-500 bg-blue-500/10'
                      : priorResult && value !== undefined
                        ? isCorrect
                          ? 'border-green-500 bg-green-500/10'
                          : 'border-red-500 bg-red-500/10'
                        : 'border-line bg-surface',
                  ].join(' ')}
                >
                  <span>{l}</span>
                  {value && (
                    <span className="text-xs text-ink-tertiary">→ {value}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <ul className="space-y-1.5">
          {rights.map((r) => {
            const used = usedRights.has(r);
            return (
              <li key={r}>
                <button
                  type="button"
                  disabled={busy || locked || used || !pickedLeft}
                  onClick={() => pickRight(r)}
                  className={[
                    'w-full rounded border px-2 py-1.5 text-left text-sm',
                    used
                      ? 'border-dashed border-line text-ink-tertiary line-through'
                      : pickedLeft
                        ? 'border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10'
                        : 'border-line bg-surface',
                  ].join(' ')}
                >
                  {r}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {!locked && (
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy || !fullyMapped}
          onClick={() => onSubmit({ mapping })}
        >
          {busy ? 'Submitting…' : priorResult ? 'Try again' : 'Submit'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Short answer (AI graded)
// ---------------------------------------------------------------------------

export function ShortAnswerWidget({ interaction, priorResult, busy, onSubmit }: WidgetProps) {
  const [text, setText] = useState('');
  const locked = priorResult?.passed === true;
  const passThreshold = (interaction.config.passThreshold as number | undefined) ?? 0.7;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{interaction.prompt}</p>
      <p className="text-xs text-ink-tertiary">
        Your answer will be graded by AI against the author's rubric. Pass
        threshold: {Math.round(passThreshold * 100)}%.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy || locked}
        rows={5}
        maxLength={8000}
        className="form-textarea w-full"
        placeholder="Type your answer…"
      />
      {priorResult && (
        <div
          className={[
            'rounded border px-2 py-2 text-sm',
            priorResult.passed
              ? 'border-green-500/40 bg-green-500/10'
              : 'border-amber-500/40 bg-amber-500/10',
          ].join(' ')}
        >
          <p className="flex items-center gap-1.5 font-medium">
            {priorResult.passed ? (
              <CheckCircle2 className="size-4 text-green-600" />
            ) : (
              <XCircle className="size-4 text-amber-600" />
            )}
            Score: {(priorResult.score * 100).toFixed(0)}%
          </p>
          {priorResult.rationale && (
            <p className="mt-1 text-xs text-ink-secondary">{priorResult.rationale}</p>
          )}
        </div>
      )}
      {!locked && (
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy || text.trim().length === 0}
          onClick={() => onSubmit({ text: text.trim() })}
        >
          <Send className="size-4" />
          {busy ? 'Grading…' : priorResult ? 'Try again' : 'Submit answer'}
        </button>
      )}
    </div>
  );
}
