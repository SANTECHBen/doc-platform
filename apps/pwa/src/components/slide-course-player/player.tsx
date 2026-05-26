'use client';

// SlideCoursePlayer — the runtime view of an authored slide course.
//
// Lifecycle:
//   mount:  GET /enrollments/:id/slide-course → deck + slides + sanitized
//           interactions + prior answers (so reload mid-course rehydrates).
//   per-slide: render image + voiceover audio + interactions; gate Next on
//           the slide's navigationGate.
//   on advance: POST /progress with the new index.
//   on answer: POST /answer → kind-specific grade + reveal payload.
//   on finish: POST /submit → final aggregate written into activity_results.
//
// The player is intentionally a mobile-first single column layout —
// the PWA's primary surface is a phone in a tech's pocket.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  XCircle,
} from 'lucide-react';
import {
  getPlayerDeck,
  postAnswer,
  postProgress,
  postSubmit,
  type AnswerResult,
  type PlayerDeck,
  type PlayerInteraction,
  type PlayerSlide,
  type SubmitResult,
} from '@/lib/slide-course-api';
import {
  buildInitialPlayState,
  canAdvance,
  type SlidePlayState,
} from './gate-checker';
import {
  DragMatchWidget,
  McqWidget,
  ShortAnswerWidget,
  TrueFalseWidget,
} from './widgets';

const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? '';
const DEV_ORG_ID = process.env.NEXT_PUBLIC_DEV_ORG_ID ?? '';

interface PlayerProps {
  enrollmentId: string;
  activityId: string;
  onExit?: () => void;
}

export function SlideCoursePlayer({ enrollmentId, activityId, onExit }: PlayerProps) {
  const [deck, setDeck] = useState<PlayerDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [busyInteractionId, setBusyInteractionId] = useState<string | null>(null);
  const [answerResults, setAnswerResults] = useState<Record<string, AnswerResult>>({});
  const [submitting, setSubmitting] = useState(false);
  const [finalResult, setFinalResult] = useState<SubmitResult | null>(null);
  const [perSlideState, setPerSlideState] = useState<Record<string, SlidePlayState>>({});

  // -----------------------------------------------------------------
  // Initial load + state seeding.
  // -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getPlayerDeck({
          enrollmentId,
          activityId,
          devUserId: DEV_USER_ID,
          devOrgId: DEV_ORG_ID,
        });
        if (cancelled) return;
        setDeck(d);
        setCurrentIdx(Math.min(d.attempt.currentSlideIndex, d.slides.length - 1));
        const seeded: Record<string, SlidePlayState> = {};
        for (const s of d.slides) seeded[s.id] = buildInitialPlayState(s);
        setPerSlideState(seeded);
        // Hydrate answer results from prior answers (so locked widgets
        // re-render with reveal payloads where possible).
        const seededResults: Record<string, AnswerResult> = {};
        for (const s of d.slides) {
          for (const i of s.interactions) {
            if (i.prior) {
              seededResults[i.id] = {
                interactionId: i.id,
                isCorrect: i.prior.isCorrect,
                score: i.prior.score ?? 0,
                passed: i.prior.isCorrect === true,
                rationale: i.prior.rationale,
                reveal: {},
              };
            }
          }
        }
        setAnswerResults(seededResults);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrollmentId, activityId]);

  // -----------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------
  const currentSlide = useMemo<PlayerSlide | null>(
    () => (deck?.slides[currentIdx] as PlayerSlide | undefined) ?? null,
    [deck, currentIdx],
  );
  const currentState = currentSlide ? perSlideState[currentSlide.id] : undefined;
  const canGoNext = currentSlide && currentState
    ? canAdvance(currentSlide, currentState)
    : false;
  const isLast = deck ? currentIdx === deck.slides.length - 1 : false;

  // -----------------------------------------------------------------
  // Server pushes — progress + submit
  // -----------------------------------------------------------------
  const reportProgress = useCallback(
    async (newIdx: number) => {
      try {
        await postProgress({
          enrollmentId,
          activityId,
          currentSlideIndex: newIdx,
          devUserId: DEV_USER_ID,
          devOrgId: DEV_ORG_ID,
        });
      } catch {
        /* progress is best-effort; reload from scratch will use what's there */
      }
    },
    [enrollmentId, activityId],
  );

  function advance() {
    if (!deck) return;
    if (isLast) {
      void submit();
      return;
    }
    const next = currentIdx + 1;
    setCurrentIdx(next);
    void reportProgress(next);
  }
  function back() {
    if (currentIdx === 0) return;
    setCurrentIdx(currentIdx - 1);
  }
  async function submit() {
    setSubmitting(true);
    try {
      const r = await postSubmit({
        enrollmentId,
        activityId,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      setFinalResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // -----------------------------------------------------------------
  // Interaction submit handler
  // -----------------------------------------------------------------
  async function onAnswer(interaction: PlayerInteraction, rawAnswer: unknown) {
    if (busyInteractionId) return;
    setBusyInteractionId(interaction.id);
    try {
      const result = await postAnswer({
        enrollmentId,
        activityId,
        interactionId: interaction.id,
        kind: interaction.kind,
        answer: rawAnswer,
        devUserId: DEV_USER_ID,
        devOrgId: DEV_ORG_ID,
      });
      setAnswerResults((m) => ({ ...m, [interaction.id]: result }));
      // Bubble into per-slide state for gate-check.
      if (currentSlide) {
        setPerSlideState((m) => ({
          ...m,
          [currentSlide.id]: {
            ...(m[currentSlide.id] ?? buildInitialPlayState(currentSlide)),
            interactionResults: {
              ...(m[currentSlide.id]?.interactionResults ?? {}),
              [interaction.id]: { passed: result.passed },
            },
          },
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyInteractionId(null);
    }
  }

  function onVoiceoverEnded() {
    if (!currentSlide) return;
    setPerSlideState((m) => ({
      ...m,
      [currentSlide.id]: {
        ...(m[currentSlide.id] ?? buildInitialPlayState(currentSlide)),
        voiceoverEnded: true,
      },
    }));
  }

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------
  if (error) {
    return (
      <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
        {error}
      </div>
    );
  }
  if (!deck) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-ink-tertiary">
        <Loader2 className="size-4 animate-spin" /> Loading course…
      </div>
    );
  }
  if (deck.deck.conversionStatus !== 'ready') {
    return (
      <div className="rounded border border-line bg-surface p-4 text-sm">
        This course is still being prepared (status: {deck.deck.conversionStatus}).
        Try again in a moment.
      </div>
    );
  }
  if (deck.slides.length === 0) {
    return (
      <div className="rounded border border-dashed border-line p-4 text-sm text-ink-tertiary">
        This course has no slides yet.
      </div>
    );
  }

  if (finalResult) {
    return <FinalScorePanel result={finalResult} onExit={onExit} />;
  }

  if (!currentSlide) return null;

  return (
    <div className="flex flex-col gap-3 pb-24">
      <header className="flex items-center justify-between">
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1 text-sm text-ink-tertiary hover:text-ink-primary"
        >
          <ArrowLeft className="size-4" /> Exit
        </button>
        <span className="text-xs text-ink-tertiary">
          Slide {currentIdx + 1} of {deck.slides.length}
        </span>
      </header>

      <ProgressBar
        total={deck.slides.length}
        currentIdx={currentIdx}
        perSlideState={perSlideState}
        slides={deck.slides}
      />

      <SlideView slide={currentSlide} onVoiceoverEnded={onVoiceoverEnded} />

      {currentSlide.interactions.length > 0 && (
        <section className="space-y-3 rounded border border-line bg-surface-raised p-3">
          {currentSlide.interactions.map((it) => (
            <InteractionRunner
              key={it.id}
              interaction={it}
              priorResult={answerResults[it.id] ?? null}
              busy={busyInteractionId === it.id}
              onSubmit={(ans) => onAnswer(it, ans)}
            />
          ))}
        </section>
      )}

      <nav className="fixed inset-x-0 bottom-0 flex items-center justify-between border-t border-line bg-surface-raised p-3">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={currentIdx === 0}
          onClick={back}
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canGoNext || submitting}
          onClick={advance}
        >
          {isLast ? (submitting ? 'Submitting…' : 'Finish') : 'Next'}
          <ArrowRight className="size-4" />
        </button>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlideView — image + voiceover audio + script
// ---------------------------------------------------------------------------

function SlideView({
  slide,
  onVoiceoverEnded,
}: {
  slide: PlayerSlide;
  onVoiceoverEnded: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Reset the voiceover-ended state implicitly via the player's per-
  // slide state machine when slide changes; no local state needed here.

  return (
    <section className="space-y-3">
      {slide.title && (
        <h2 className="text-base font-medium">{slide.title}</h2>
      )}
      {slide.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={slide.imageUrl}
          alt={slide.title ?? `Slide ${slide.index + 1}`}
          className="w-full rounded border border-line"
        />
      )}
      {slide.voiceoverUrl && (
        <audio
          ref={audioRef}
          src={slide.voiceoverUrl}
          controls
          onEnded={onVoiceoverEnded}
          className="w-full"
        />
      )}
      {slide.scriptMarkdown && (
        <div className="prose prose-sm max-w-none rounded border border-line bg-surface-raised p-3 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.scriptMarkdown}</ReactMarkdown>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// InteractionRunner — picks the right widget
// ---------------------------------------------------------------------------

function InteractionRunner(props: {
  interaction: PlayerInteraction;
  priorResult: AnswerResult | null;
  busy: boolean;
  onSubmit: (answer: unknown) => Promise<void>;
}) {
  const { interaction } = props;
  if (interaction.kind === 'mcq') return <McqWidget {...props} />;
  if (interaction.kind === 'true_false') return <TrueFalseWidget {...props} />;
  if (interaction.kind === 'drag_match') return <DragMatchWidget {...props} />;
  return <ShortAnswerWidget {...props} />;
}

// ---------------------------------------------------------------------------
// Progress bar — segmented dots, one per slide
// ---------------------------------------------------------------------------

function ProgressBar({
  total,
  currentIdx,
  perSlideState,
  slides,
}: {
  total: number;
  currentIdx: number;
  perSlideState: Record<string, SlidePlayState>;
  slides: PlayerSlide[];
}) {
  return (
    <div className="flex w-full items-center gap-0.5">
      {slides.map((s, i) => {
        const isCurrent = i === currentIdx;
        const state = perSlideState[s.id];
        const complete =
          state && canAdvance(s, state) && i < currentIdx;
        return (
          <span
            key={s.id}
            className={[
              'h-1.5 flex-1 rounded-full transition',
              isCurrent ? 'bg-blue-500' : complete ? 'bg-green-500' : 'bg-line',
            ].join(' ')}
          />
        );
      })}
      <span className="ml-2 text-xs tabular-nums text-ink-tertiary">
        {Math.round(((currentIdx + 1) / total) * 100)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Final score panel
// ---------------------------------------------------------------------------

function FinalScorePanel({
  result,
  onExit,
}: {
  result: SubmitResult;
  onExit?: () => void;
}) {
  const Icon = result.passed ? CheckCircle2 : XCircle;
  return (
    <div className="space-y-4 p-6 text-center">
      <Icon
        className={[
          'mx-auto size-12',
          result.passed ? 'text-green-600' : 'text-red-600',
        ].join(' ')}
      />
      <h2 className="text-xl font-semibold">
        {result.passed ? 'Course passed!' : 'Course not passed'}
      </h2>
      <p className="text-sm text-ink-secondary">
        Score: <strong>{(result.attemptScore * 100).toFixed(0)}%</strong> ·
        Pass threshold: {(result.passThreshold * 100).toFixed(0)}%
      </p>
      <p className="text-xs text-ink-tertiary">
        {result.answeredCount} of {result.interactionsCount} interactions
        answered. Enrollment status: <strong>{result.enrollmentStatus}</strong>.
      </p>
      {onExit && (
        <button type="button" className="btn btn-primary" onClick={onExit}>
          Back to training
        </button>
      )}
    </div>
  );
}
