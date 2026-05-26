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
  Maximize2,
  Minimize2,
  XCircle,
} from 'lucide-react';
import {
  getPlayerDeck,
  postAnswer,
  type AnswerResult,
  type PlayerBlock,
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

  // -----------------------------------------------------------------
  // Fullscreen mode
  // -----------------------------------------------------------------
  // Two layers:
  //   1. Native Fullscreen API — works on Android Chrome + desktop.
  //      iOS Safari only allows fullscreen on <video> elements, so the
  //      requestFullscreen() call below silently no-ops there.
  //   2. CSS pseudo-fullscreen — always works. We toggle a flag that
  //      pins the player container to the viewport with z-50, so iOS
  //      learners still get an immersive view.
  //
  // On landscape rotation we auto-enter (best-effort). The browser may
  // reject requestFullscreen() if there's no recent user activation —
  // in that case we still apply the CSS fullscreen so the player
  // expands to fill the screen.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true);
    const el = containerRef.current ?? document.documentElement;
    const req =
      (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
        .requestFullscreen ??
      (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen;
    if (req) {
      try {
        const p = req.call(el);
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => {
            /* iOS / no-activation rejections fall through to CSS-only mode */
          });
        }
      } catch {
        /* ignore — CSS fullscreen still applies */
      }
    }
    // Best-effort orientation lock for Android. iOS ignores this.
    const so = (screen as Screen & {
      orientation?: { lock?: (o: string) => Promise<void> };
    }).orientation;
    if (so?.lock) {
      try {
        const p = so.lock('landscape');
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
    const so = (screen as Screen & {
      orientation?: { unlock?: () => void };
    }).orientation;
    if (so?.unlock) {
      try {
        so.unlock();
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Auto-enter fullscreen when the device rotates to landscape on a
  // phone-sized viewport. Desktop monitors are typically landscape so
  // we gate on max-width to avoid hijacking the desktop layout.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(orientation: landscape) and (max-width: 1024px)');
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if ((e as MediaQueryListEvent).matches ?? (e as MediaQueryList).matches) {
        enterFullscreen();
      } else {
        // Don't auto-exit — the learner might want to stay fullscreen.
        // The button below is the explicit exit.
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [enterFullscreen]);

  // Keep state synced when the user exits native fullscreen via Esc.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => {
      if (!document.fullscreenElement) setIsFullscreen((prev) => prev);
      // Note: we don't force isFullscreen=false here because CSS-only
      // fullscreen has no native counterpart. The user toggles via the
      // button when they want to leave.
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

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
    <div
      ref={containerRef}
      className={[
        'flex flex-col gap-3 pb-24',
        // CSS pseudo-fullscreen — pins the player to the viewport so
        // it covers the asset hub chrome even when the native Fullscreen
        // API is unavailable (iOS Safari on non-video elements).
        isFullscreen
          ? 'fixed inset-0 z-50 overflow-y-auto bg-surface-base p-3'
          : '',
      ].join(' ')}
    >
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
        <button
          type="button"
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          className="rounded p-1 text-ink-tertiary transition hover:bg-surface-elevated hover:text-ink-primary"
        >
          {isFullscreen ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </button>
      </header>

      <ProgressBar
        total={deck.slides.length}
        currentIdx={currentIdx}
        perSlideState={perSlideState}
        slides={deck.slides}
      />

      <SlideView
        slide={currentSlide}
        isFullscreen={isFullscreen}
        hasInteractions={currentSlide.interactions.length > 0}
        onVoiceoverEnded={onVoiceoverEnded}
      />

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

      <nav className="fixed inset-x-0 bottom-0 z-[60] flex items-center justify-between border-t border-line bg-surface-raised p-3">
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
  isFullscreen,
  hasInteractions,
  onVoiceoverEnded,
}: {
  slide: PlayerSlide;
  isFullscreen: boolean;
  hasInteractions: boolean;
  onVoiceoverEnded: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Autoplay the voiceover when the slide changes. Mobile browsers
  // require a prior user gesture to unmute autoplay — the learner's
  // tap to enter the player counts, so subsequent slide changes
  // should play freely. If the browser rejects (older iOS, no prior
  // interaction), we leave the audio controls visible so the learner
  // can tap play manually.
  useEffect(() => {
    if (!slide.voiceoverUrl) return;
    const el = audioRef.current;
    if (!el) return;
    // Force a reload so the element pulls the new src — needed when
    // React reuses the same <audio> node across slide changes.
    try {
      el.currentTime = 0;
    } catch {
      /* ignore — some browsers throw before metadata loads */
    }
    const tryPlay = () => {
      el.play().catch(() => {
        /* autoplay blocked; controls remain visible for manual tap */
      });
    };
    if (el.readyState >= 2) {
      tryPlay();
    } else {
      el.addEventListener('canplay', tryPlay, { once: true });
      return () => el.removeEventListener('canplay', tryPlay);
    }
  }, [slide.voiceoverUrl]);
  // Tighten the image's height in fullscreen so the whole slide fits
  // inside the device viewport without scrolling. The subtracted values
  // reserve space for the fixed header, bottom nav, and any
  // interactions/audio below. We use `dvh` (dynamic viewport height) so
  // mobile browser chrome (URL bar showing/hiding) doesn't clip the
  // image; `vh` is the fallback for older engines.
  const imgClass = isFullscreen
    ? [
        'mx-auto block w-auto rounded border border-line object-contain',
        hasInteractions
          ? 'max-h-[40dvh] sm:max-h-[55dvh]'
          : 'max-h-[calc(100dvh-180px)]',
        'max-w-full',
      ].join(' ')
    : 'block w-full rounded border border-line';
  const positioned = slide.blocks.filter(
    (b) => b.x !== undefined || b.y !== undefined,
  );
  const stacked = slide.blocks.filter(
    (b) => b.x === undefined && b.y === undefined,
  );
  const showCanvas = slide.imageUrl !== null || positioned.length > 0;
  return (
    <section className="space-y-3">
      {slide.title && <h2 className="text-base font-medium">{slide.title}</h2>}
      {showCanvas && (
        <div
          className="relative w-full overflow-hidden rounded border border-line bg-white"
          style={{ aspectRatio: '16 / 9' }}
        >
          {slide.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={slide.imageUrl}
              alt={slide.title ?? `Slide ${slide.index + 1}`}
              className="pointer-events-none absolute inset-0 size-full object-contain"
            />
          )}
          {positioned.map((b, i) => (
            <PositionedBlock key={i} block={b} />
          ))}
        </div>
      )}
      {slide.voiceoverUrl && (
        <audio
          ref={audioRef}
          src={slide.voiceoverUrl}
          controls
          autoPlay
          onEnded={onVoiceoverEnded}
          className="w-full"
        />
      )}
      {stacked.length > 0 && (
        <div className="space-y-3">
          {stacked.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>
      )}
      {slide.scriptMarkdown && (
        <div className="prose prose-sm max-w-none rounded border border-line bg-surface-raised p-3 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{slide.scriptMarkdown}</ReactMarkdown>
        </div>
      )}
    </section>
  );
}

// PositionedBlock — renders a block absolutely on a 16:9 canvas, mirror
// of the admin's SlideCanvasEditor placement.
function PositionedBlock({ block }: { block: PlayerBlock }) {
  const x = block.x ?? 10;
  const y = block.y ?? 10;
  const w = block.w ?? 50;
  const h = block.h ?? 25;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${x}%`,
    top: `${y}%`,
    width: `${w}%`,
    height: `${h}%`,
  };
  if (block.kind === 'text') {
    return (
      <div
        style={{
          ...style,
          fontSize: block.fontSize ? `${block.fontSize}px` : undefined,
          textAlign: block.align ?? 'left',
        }}
        className="overflow-hidden whitespace-pre-wrap p-2 text-sm text-ink-primary"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.markdown}</ReactMarkdown>
      </div>
    );
  }
  if (block.kind === 'image') {
    return (
      <img
        style={style}
        src={block.url}
        alt={block.caption ?? ''}
        // eslint-disable-next-line @next/next/no-img-element
        className="object-contain"
      />
    );
  }
  if (block.kind === 'video_file') {
    return (
      <video
        style={style}
        src={block.url}
        controls
        playsInline
        className="object-contain"
      />
    );
  }
  // video_url
  const embed = embeddableSrc(block.url);
  if (!embed) {
    return (
      <a
        style={style}
        href={block.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center rounded border border-line bg-surface text-xs text-accent underline"
      >
        {block.url}
      </a>
    );
  }
  return (
    <iframe
      style={style}
      src={embed}
      title={block.caption ?? 'Video'}
      className="border-0"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
    />
  );
}

function BlockView({ block }: { block: PlayerBlock }) {
  if (block.kind === 'text') {
    return (
      <div className="prose prose-sm max-w-none rounded border border-line bg-surface-raised p-3 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.markdown}</ReactMarkdown>
      </div>
    );
  }
  if (block.kind === 'image') {
    return (
      <figure className="space-y-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={block.url}
          alt={block.caption ?? ''}
          className="w-full rounded border border-line"
        />
        {block.caption && (
          <figcaption className="text-xs text-ink-tertiary">{block.caption}</figcaption>
        )}
      </figure>
    );
  }
  if (block.kind === 'video_file') {
    return (
      <figure className="space-y-1">
        <video
          src={block.url}
          controls
          playsInline
          className="w-full rounded border border-line"
        />
        {block.caption && (
          <figcaption className="text-xs text-ink-tertiary">{block.caption}</figcaption>
        )}
      </figure>
    );
  }
  // video_url — embed via iframe if it's an embeddable URL; otherwise
  // fall back to a clickable link.
  const embed = embeddableSrc(block.url);
  return (
    <figure className="space-y-1">
      {embed ? (
        <div className="relative aspect-video w-full overflow-hidden rounded border border-line">
          <iframe
            src={embed}
            title={block.caption ?? 'Video'}
            className="absolute inset-0 size-full"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>
      ) : (
        <a
          href={block.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded border border-line bg-surface-raised p-3 text-sm text-accent underline"
        >
          {block.url}
        </a>
      )}
      {block.caption && (
        <figcaption className="text-xs text-ink-tertiary">{block.caption}</figcaption>
      )}
    </figure>
  );
}

// Convert common video-share URLs to their embed form. Returns null
// when the URL isn't a recognized provider so the player can fall back
// to a plain link.
function embeddableSrc(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v');
      if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\//, '');
      if (id) return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
    }
    if (host === 'vimeo.com') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    if (host.endsWith('mux.com') || u.pathname.endsWith('.m3u8')) {
      // Mux embeds typically come through the stream URL as-is.
      return url;
    }
    return null;
  } catch {
    return null;
  }
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
