'use client';

// Slide-course player — runtime view of an authored course.
//
// Anonymous scan-session is the only auth required. The server grades
// each interaction (correct answers never reach the client) and the
// player accumulates scores in memory for a final summary. Nothing is
// persisted server-side; that flow can come back later for
// authenticated learners who want completion records.

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
  type AnswerResult,
  type PlayerDeck,
  type PlayerInteraction,
  type PlayerSlide,
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

interface PlayerProps {
  activityId: string;
  onExit?: () => void;
}

export function SlideCoursePlayer({ activityId, onExit }: PlayerProps) {
  const [deck, setDeck] = useState<PlayerDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [busyInteractionId, setBusyInteractionId] = useState<string | null>(null);
  const [answerResults, setAnswerResults] = useState<Record<string, AnswerResult>>({});
  const [perSlideState, setPerSlideState] = useState<Record<string, SlidePlayState>>({});
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getPlayerDeck({ activityId });
        if (cancelled) return;
        setDeck(d);
        const seeded: Record<string, SlidePlayState> = {};
        for (const s of d.slides) seeded[s.id] = buildInitialPlayState(s);
        setPerSlideState(seeded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  const currentSlide = useMemo<PlayerSlide | null>(
    () => (deck?.slides[currentIdx] as PlayerSlide | undefined) ?? null,
    [deck, currentIdx],
  );
  const currentState = currentSlide ? perSlideState[currentSlide.id] : undefined;
  const canGoNext = currentSlide && currentState
    ? canAdvance(currentSlide, currentState)
    : false;
  const isLast = deck ? currentIdx === deck.slides.length - 1 : false;

  function advance() {
    if (!deck) return;
    if (isLast) {
      setFinished(true);
      return;
    }
    setCurrentIdx(currentIdx + 1);
  }
  function back() {
    if (currentIdx === 0) return;
    setCurrentIdx(currentIdx - 1);
  }

  const onAnswer = useCallback(
    async (interaction: PlayerInteraction, rawAnswer: unknown) => {
      if (busyInteractionId) return;
      setBusyInteractionId(interaction.id);
      try {
        const result = await postAnswer({
          activityId,
          interactionId: interaction.id,
          kind: interaction.kind,
          answer: rawAnswer,
        });
        setAnswerResults((m) => ({ ...m, [interaction.id]: result }));
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
    },
    [activityId, busyInteractionId, currentSlide],
  );

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

  if (finished) {
    return <FinalScorePanel deck={deck} results={answerResults} onExit={onExit} />;
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
          disabled={!canGoNext}
          onClick={advance}
        >
          {isLast ? 'Finish' : 'Next'}
          <ArrowRight className="size-4" />
        </button>
      </nav>
    </div>
  );
}

function SlideView({
  slide,
  onVoiceoverEnded,
}: {
  slide: PlayerSlide;
  onVoiceoverEnded: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  return (
    <section className="space-y-3">
      {slide.title && <h2 className="text-base font-medium">{slide.title}</h2>}
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

function FinalScorePanel({
  deck,
  results,
  onExit,
}: {
  deck: PlayerDeck;
  results: Record<string, AnswerResult>;
  onExit?: () => void;
}) {
  // Compute the aggregate locally from accumulated graded answers.
  // Server doesn't track this attempt (scan-session is anonymous).
  let totalWeight = 0;
  let weighted = 0;
  let interactionCount = 0;
  let answered = 0;
  for (const s of deck.slides) {
    for (const i of s.interactions) {
      interactionCount += 1;
      totalWeight += i.weight;
      const r = results[i.id];
      if (r) {
        answered += 1;
        weighted += r.score * i.weight;
      }
    }
  }
  const aggregate = totalWeight > 0 ? weighted / totalWeight : 1;
  const passed = aggregate >= deck.deck.passThreshold;
  const Icon = passed ? CheckCircle2 : XCircle;
  return (
    <div className="space-y-4 p-6 text-center">
      <Icon
        className={[
          'mx-auto size-12',
          passed ? 'text-green-600' : 'text-red-600',
        ].join(' ')}
      />
      <h2 className="text-xl font-semibold">
        {interactionCount === 0
          ? 'Course complete'
          : passed
            ? 'Course passed!'
            : 'Course not passed'}
      </h2>
      {interactionCount > 0 && (
        <p className="text-sm text-ink-secondary">
          Score: <strong>{(aggregate * 100).toFixed(0)}%</strong> · Pass
          threshold: {(deck.deck.passThreshold * 100).toFixed(0)}%
        </p>
      )}
      <p className="text-xs text-ink-tertiary">
        {answered} of {interactionCount} interactions answered.
      </p>
      {onExit && (
        <button type="button" className="btn btn-primary" onClick={onExit}>
          Back to training
        </button>
      )}
    </div>
  );
}
