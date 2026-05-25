'use client';

// VirtualJobAidReels — vertical, snap-scrolling, video-first reader for
// procedures. Each step is a full-viewport panel: looping clip background
// (or first photo if no video), title pinned at the bottom, a small
// chevron in the corner that opens the full step text sheet.
//
// Why this exists alongside the classic Job Aid layout:
//   * Walkthrough videos plus AI voiceover already convey the steps;
//     text is mostly redundant when both are present.
//   * Techs hold the phone in one hand — vertical swipes are easier than
//     hunting the Next button.
//   * Reference use (jumping to "the step with the torque spec") still
//     works via the phase-progress strip pinned at the top.
//
// What it does NOT do:
//   * Auto-advance between steps. Advance is always user-initiated (swipe
//     or tap on the phase strip). Safety-critical steps therefore can't
//     be sped past — the tech has to physically scroll off them.
//   * Capture evidence. This component is read-only — the same as the
//     classic VJA. Evidence capture lives in ProcedureRunner.
//
// Lifecycle:
//   * Parent owns stepIdx + muted + voiceover orchestration. We notify on
//     scroll-stop via onStepChange; the parent's useEffect on stepIdx
//     handles speak/stop.
//   * Only the active step ± 1 mount their actual video element. Beyond
//     that we render the poster image. Keeps memory below ~3 video
//     decoders concurrent on a typical mobile browser.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronUp, ChevronDown, RefreshCw, ShieldAlert, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MuxClipPlayer } from './mux-clip-player';
import { StepVideoPlayer } from './step-video-player';
import { CategoryIcon } from './procedure-runner/category-icon';
import type { ProcedureStepCategoryDto, StepBlock } from '@/lib/api';

// Structural media shape — narrower than the API's ProcedureStepMedia
// (we don't need mime here) and wider where it matters (url is always
// resolved server-side for the runner). Keeps the contract with VJA
// straightforward: VJA strips fields it doesn't need before passing
// them in, and this component doesn't care about what was stripped.
type ReelMediaItem =
  | { kind: 'image'; storageKey: string; url?: string | null; caption?: string }
  | { kind: 'video'; storageKey: string; url?: string | null; caption?: string }
  | {
      kind: 'video_clip';
      storageKey: string;
      url?: string | null;
      caption?: string;
      clip: {
        playbackId: string;
        startMs: number;
        endMs: number;
        streamUrl: string;
        aspectRatio?: string;
        orientation?: 'portrait' | 'landscape' | 'square';
      };
    };

// Resolved step shape — kept loose so VJA can pass its own type without
// re-importing internal types. Mirrors the fields the Reels view reads.
export interface ReelStep {
  id: string | null;
  title: string;
  bodyMarkdown: string | null;
  blocks: StepBlock[];
  safetyCritical: boolean;
  media: ReelMediaItem[];
  sectionLabel: string | null;
  sectionStepIndex: number;
  sectionStepTotal: number;
  category: ProcedureStepCategoryDto | null;
}

export interface ReelsViewportHandle {
  /** Imperatively scroll to a specific step index. Used by the parent's
   *  phase-strip-tap handler and voice-search deep links. */
  scrollToStep: (idx: number, smooth?: boolean) => void;
}

interface Props {
  steps: ReelStep[];
  /** Currently-active step index. Drives autoplay scoping (the active
   *  step gets its real <video>; neighbors get the poster). */
  stepIdx: number;
  /** Called when the snap-scroll settles on a new step. Debounced
   *  inside this component so rapid swipes don't fire intermediate
   *  values. */
  onStepChange: (next: number) => void;
  /** Speak / replay voiceover for the current step. Called when the
   *  user taps the replay button on the active reel. */
  onReplayVoiceover: () => void;
  /** True while audio is actively playing — drives the replay-button
   *  spinner state. */
  speaking: boolean;
  /** Mute state — exposed so the no-video card can render a hint when
   *  audio is the primary content. */
  muted: boolean;
  /** Phase descriptors for the optional phase-progress strip overlay.
   *  Empty array hides the strip. */
  phases: Array<{
    key: string | null;
    label: string;
    color: string;
    icon: string | null;
    start: number;
    end: number;
  }>;
  /** Resolved category for an active step — drives the section pill on
   *  the reel. The parent computes this once and threads it down. */
  activePhaseColor: string | null;
}

// How long to wait after a scroll event before treating the new position
// as the user's intended target. IntersectionObserver fires frequently
// during a momentum scroll; we only commit (and trigger voiceover) after
// motion settles.
const SCROLL_SETTLE_MS = 220;

export const VirtualJobAidReels = forwardRef<ReelsViewportHandle, Props>(
  function VirtualJobAidReels(
    {
      steps,
      stepIdx,
      onStepChange,
      onReplayVoiceover,
      speaking,
      muted,
      phases,
      activePhaseColor,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const reelRefs = useRef<(HTMLElement | null)[]>([]);
    const [sheetOpenIdx, setSheetOpenIdx] = useState<number | null>(null);
    // Index whose intersection most recently became dominant. Decoupled
    // from the parent's stepIdx so a momentum scroll can pass through
    // intermediate values without firing onStepChange for each.
    const dominantIdxRef = useRef<number>(stepIdx);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Imperatively scroll to a target step. Used by the parent for:
    //   - phase-strip taps (jump to phase start)
    //   - voice-search deep links (mount-time jump)
    //   - prev/next button presses if the parent kept them around
    useImperativeHandle(
      ref,
      () => ({
        scrollToStep(idx: number, smooth = true) {
          const target = reelRefs.current[idx];
          if (!target) return;
          target.scrollIntoView({
            behavior: smooth ? 'smooth' : 'auto',
            block: 'start',
          });
        },
      }),
      [],
    );

    // When the parent's stepIdx changes from OUTSIDE (a phase-strip tap,
    // a deep link), pull the viewport in line. We compare against the
    // observer's dominantIdx so we don't fight a user-initiated scroll.
    useEffect(() => {
      if (dominantIdxRef.current === stepIdx) return;
      const target = reelRefs.current[stepIdx];
      if (!target) return;
      // 'auto' for the initial mount; 'smooth' for runtime jumps. We
      // detect "initial" via a sentinel ref so a deep link doesn't
      // animate a long sweep from step 0 → step 17.
      target.scrollIntoView({ behavior: 'auto', block: 'start' });
      dominantIdxRef.current = stepIdx;
    }, [stepIdx]);

    // IntersectionObserver-based active-step detection. Each reel reports
    // its visible fraction; we pick the one with the largest ratio as
    // dominant and settle onto it after the scroll stops moving.
    useEffect(() => {
      const root = containerRef.current;
      if (!root) return;
      const ratioByIdx = new Map<number, number>();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const idxAttr = (entry.target as HTMLElement).dataset.reelIdx;
            if (idxAttr == null) continue;
            ratioByIdx.set(Number(idxAttr), entry.intersectionRatio);
          }
          // Pick the most-visible reel.
          let best = -1;
          let bestRatio = -1;
          for (const [idx, ratio] of ratioByIdx) {
            if (ratio > bestRatio) {
              best = idx;
              bestRatio = ratio;
            }
          }
          if (best < 0 || bestRatio < 0.5) return;
          dominantIdxRef.current = best;
          // Debounce-settle. We only notify the parent after the scroll
          // has stopped — that's when voiceover should trigger.
          if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(() => {
            onStepChange(best);
          }, SCROLL_SETTLE_MS);
        },
        {
          root,
          // Multiple thresholds so we get a smooth ratio readout rather
          // than a binary "in/out" — gives the "biggest ratio wins"
          // selection above stable behavior on slow scrolls.
          threshold: [0.25, 0.5, 0.75, 1],
        },
      );
      // Observe every mounted reel.
      for (const el of reelRefs.current) {
        if (el) observer.observe(el);
      }
      return () => {
        observer.disconnect();
        if (settleTimerRef.current) {
          clearTimeout(settleTimerRef.current);
          settleTimerRef.current = null;
        }
      };
    }, [onStepChange, steps.length]);

    // Close the text sheet when the active step changes (so the sheet
    // doesn't carry across a swipe — feels broken otherwise).
    useEffect(() => {
      setSheetOpenIdx(null);
    }, [stepIdx]);

    return (
      <div
        ref={containerRef}
        className="vja-reels"
        // The parent renders the close + topbar above this; we don't
        // need our own. Body scroll is locked by the parent.
        role="region"
        aria-label="Procedure steps (vertical swipe)"
      >
        {steps.map((step, i) => {
          const isActive = i === stepIdx;
          // Render real video only for active ± 1 so we keep ≤ 3 video
          // decoders simultaneous on mobile.
          const renderVideo = Math.abs(i - stepIdx) <= 1;
          const isSheetOpen = sheetOpenIdx === i;
          // Step's pill color: step-specific override > phase color >
          // neutral. The parent passes the active phase color; for
          // inactive reels we just use the step's own category if any.
          const pillColor = step.category?.color ?? (isActive ? activePhaseColor : null);
          // Media classification — drives whether we render the classic
          // video-first layout or the new text-forward layout. A step
          // with no video AND no image leaves the video-first layout
          // looking broken (empty gradient + bottom-pinned text), so we
          // pivot to a centered text card instead.
          const hasVideo = step.media.some(
            (m) => m.kind === 'video' || m.kind === 'video_clip',
          );
          const hasImage = step.media.some((m) => m.kind === 'image');
          const isTextOnly = !hasVideo && !hasImage;
          // Body preview shown on text-only reels. Cheap to compute and
          // memoization adds little since reels mount lazily — keep inline.
          const previewText = isTextOnly
            ? extractPreviewText(step.blocks, step.bodyMarkdown)
            : '';
          // Phase/category tint exposed as a CSS var on the section so
          // every nested layer can read it: the reel's edge vignette
          // (video reels) and the saturated chapter-card bg (text-only).
          const sectionStyle: React.CSSProperties | undefined = pillColor
            ? ({ ['--reel-tint' as string]: pillColor } as React.CSSProperties)
            : undefined;
          // On text-only reels the section *is* the phase color, so
          // re-stating it on the pill would erase the label. Suppress
          // the inline color there and let the CSS rule paint a neutral
          // translucent chip instead. Video reels keep the colored pill.
          const sectionPillStyle: React.CSSProperties | undefined =
            !isTextOnly && pillColor
              ? { color: 'white', backgroundColor: pillColor }
              : undefined;
          const categoryPillStyle: React.CSSProperties | undefined =
            !isTextOnly && step.category
              ? { color: 'white', backgroundColor: step.category.color }
              : undefined;
          return (
            <section
              key={step.id ?? `inline-${i}`}
              data-reel-idx={i}
              ref={(el) => {
                reelRefs.current[i] = el;
              }}
              className={`vja-reel ${step.safetyCritical ? 'vja-reel--safety' : ''} ${
                isTextOnly ? 'vja-reel--textonly' : ''
              }`}
              style={sectionStyle}
              aria-current={isActive ? 'step' : undefined}
            >
              {isTextOnly ? (
                <div aria-hidden className="vja-reel-textonly-bg" />
              ) : (
                <ReelMedia
                  media={step.media}
                  renderVideo={renderVideo}
                  isActive={isActive}
                  playId={step.id ?? `reel-${i}`}
                />
              )}
              {/* Phase pill — small chip at the top of each reel showing
                  the section context. Mirrors the colored pill in the
                  classic view so navigating between modes stays oriented. */}
              <div className="vja-reel-top">
                {step.sectionLabel && (
                  <span className="vja-reel-section" style={sectionPillStyle}>
                    {step.sectionLabel}
                    <span className="vja-reel-section-num">
                      {' '}
                      · {step.sectionStepIndex}/{step.sectionStepTotal}
                    </span>
                  </span>
                )}
                {step.category && (
                  <span
                    className="vja-reel-section"
                    style={categoryPillStyle}
                    title={`Category: ${step.category.name}`}
                  >
                    <CategoryIcon name={step.category.icon} size={11} strokeWidth={2.25} />
                    {step.category.name}
                  </span>
                )}
                {step.safetyCritical && (
                  <span className="vja-reel-safety-pill">
                    <ShieldAlert size={12} strokeWidth={2.25} />
                    Safety
                  </span>
                )}
              </div>
              {isTextOnly ? (
                // Text-forward layout — the title and a preview snippet
                // own the screen instead of clinging to the bottom edge.
                // The whole card is the tap target for the full sheet,
                // matching the gesture users learned from media reels.
                <button
                  type="button"
                  className="vja-reel-textonly-card"
                  onClick={() => setSheetOpenIdx(i)}
                  aria-expanded={isSheetOpen}
                  aria-controls={`vja-reel-sheet-${i}`}
                >
                  {step.category && (
                    // Category icon centered above the title. The icon
                    // ringed against the colored surface gives the card
                    // a focal point and reinforces section identity
                    // without needing decorative ornament.
                    <span className="vja-reel-textonly-icon" aria-hidden>
                      <CategoryIcon
                        name={step.category.icon}
                        size={28}
                        strokeWidth={1.75}
                      />
                    </span>
                  )}
                  <h2 className="vja-reel-textonly-title">{step.title}</h2>
                  {previewText && (
                    <p className="vja-reel-textonly-preview">{previewText}</p>
                  )}
                  {previewText ? (
                    <span className="vja-reel-textonly-cta">
                      <ChevronUp size={14} strokeWidth={2.5} />
                      Tap for full step
                    </span>
                  ) : (
                    // No body text either — surface that explicitly so
                    // the tech doesn't tap looking for hidden detail.
                    <span className="vja-reel-textonly-cta vja-reel-textonly-cta--quiet">
                      Listen to the voiceover, or tap for notes
                    </span>
                  )}
                </button>
              ) : (
                // Title pinned bottom-center over the media. Tap-target
                // sized so it acts as an alternate "open sheet" affordance.
                <button
                  type="button"
                  className="vja-reel-title-block"
                  onClick={() => setSheetOpenIdx(i)}
                  aria-expanded={isSheetOpen}
                  aria-controls={`vja-reel-sheet-${i}`}
                >
                  <h2 className="vja-reel-title">{step.title}</h2>
                  <span className="vja-reel-title-hint">
                    <ChevronUp size={14} strokeWidth={2.5} />
                    Tap for details
                  </span>
                </button>
              )}
              {/* Replay-voiceover button — small, top-right of the reel.
                  Lets the tech re-hear without scrolling away. Only on
                  the active reel; inactive ones don't have audio. */}
              {isActive && (
                <button
                  type="button"
                  className="vja-reel-replay"
                  onClick={onReplayVoiceover}
                  aria-label={speaking ? 'Voiceover playing — tap to restart' : 'Replay voiceover'}
                  title="Replay voiceover"
                >
                  <RefreshCw
                    size={16}
                    strokeWidth={2.5}
                    className={speaking ? 'vja-reel-replay-spin' : ''}
                  />
                </button>
              )}
              {/* No-video hint — only meaningful for the image-only +
                  muted case. Text-only reels already render the text,
                  so the hint would be redundant noise there. */}
              {!hasVideo && hasImage && muted && (
                <p className="vja-reel-empty">
                  Tap the title to read this step, or unmute to hear it.
                </p>
              )}
              {/* Text sheet — slides up from the bottom; backdrop dims
                  the video. Tap backdrop or chevron-down to close. */}
              <TextSheet
                open={isSheetOpen}
                onClose={() => setSheetOpenIdx(null)}
                step={step}
                id={`vja-reel-sheet-${i}`}
              />
            </section>
          );
        })}
        {/* First-time swipe hint. Shows briefly on initial mount of the
            Reels viewport then fades. We use a CSS animation that runs
            once; no JS state to manage. */}
        <div className="vja-reels-swipe-hint" aria-hidden>
          <ChevronUp size={18} strokeWidth={2.5} />
          <span>Swipe up for the next step</span>
        </div>
      </div>
    );
  },
);

// One reel's media surface. Renders the first video / video_clip when
// available; otherwise the first image; otherwise a colored placeholder.
// Lazy: when `renderVideo` is false (i.e. step is outside ±1 of current),
// we render only the poster image to keep memory under control.
function ReelMedia({
  media,
  renderVideo,
  isActive,
  playId,
}: {
  media: ReelMediaItem[];
  renderVideo: boolean;
  isActive: boolean;
  playId: string;
}) {
  // Pick a "hero" media item. Preference:
  //   1. video_clip (Mux HLS with looped range — best fit for reels)
  //   2. video (mp4/webm — also loops)
  //   3. image (still poster, only thing we can show without a video)
  const heroVideoClip = media.find((m) => m.kind === 'video_clip');
  const heroVideo = media.find((m) => m.kind === 'video');
  const heroImage = media.find((m) => m.kind === 'image');
  const heroStorageKey =
    heroVideoClip?.storageKey ?? heroVideo?.storageKey ?? heroImage?.storageKey ?? null;
  // Storage-resolved URLs are inlined by the server on each media item
  // as `url` (extended type on the API DTO). The base ProcedureStepMedia
  // type doesn't carry it; we read defensively.
  const heroUrl =
    (heroVideoClip as unknown as { url?: string | null })?.url ??
    (heroVideo as unknown as { url?: string | null })?.url ??
    (heroImage as unknown as { url?: string | null })?.url ??
    null;
  if (heroVideoClip && renderVideo) {
    const clip = (heroVideoClip as { clip?: { streamUrl: string; startMs: number; endMs: number; aspectRatio?: string; orientation?: 'portrait' | 'landscape' | 'square' } }).clip;
    if (clip?.streamUrl) {
      return (
        <div className="vja-reel-media">
          <MuxClipPlayer
            streamUrl={clip.streamUrl}
            startMs={clip.startMs}
            endMs={clip.endMs}
            posterUrl={heroUrl ?? undefined}
            // Only the active reel autoplays — keeps the neighboring
            // reels primed (HLS attached, first segment prefetched) but
            // paused on a poster frame until the tech swipes to them.
            autoplay={isActive}
            playId={playId}
            aspectRatio={clip.aspectRatio ?? null}
            orientation={clip.orientation ?? null}
            className="vja-reel-clip"
          />
        </div>
      );
    }
  }
  if (heroVideo && renderVideo && heroUrl) {
    return (
      <div className="vja-reel-media">
        <StepVideoPlayer
          src={heroUrl}
          autoplay={isActive}
          playId={playId}
          muted
          className="vja-reel-clip"
        />
      </div>
    );
  }
  // Poster-only fallback. Used for:
  //   - Steps outside ±1 of the active step (lazy)
  //   - Steps with no video at all
  //   - Steps that have only images
  return (
    <div className="vja-reel-media vja-reel-media--still">
      {heroUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={heroUrl}
          alt=""
          // object-cover by default; portrait images fit naturally. The
          // letterboxing for landscape happens via the dark background.
          className="vja-reel-still"
          loading="lazy"
          draggable={false}
        />
      ) : (
        // No media at all — colored gradient placeholder so the reel
        // doesn't look broken. Title text on top still reads.
        <div aria-hidden className="vja-reel-still-empty" />
      )}
    </div>
  );
}

// Bottom sheet that holds the full step text. Slides up over the reel
// when the title block is tapped. We keep this lightweight (no portal,
// no library) — a single absolutely-positioned panel inside the reel
// with a backdrop, both animated via CSS.
function TextSheet({
  open,
  onClose,
  step,
  id,
}: {
  open: boolean;
  onClose: () => void;
  step: ReelStep;
  id: string;
}) {
  // Touch drag-to-close. We track the gesture's vertical delta; if it
  // exceeds 80px downward, close.
  const startYRef = useRef<number | null>(null);
  const deltaRef = useRef<number>(0);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    startYRef.current = t.clientY;
    deltaRef.current = 0;
  }, []);
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (startYRef.current == null) return;
    const t = e.touches[0];
    if (!t) return;
    deltaRef.current = t.clientY - startYRef.current;
  }, []);
  const onTouchEnd = useCallback(() => {
    if (deltaRef.current > 80) onClose();
    startYRef.current = null;
    deltaRef.current = 0;
  }, [onClose]);
  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // Pull the typed blocks into the same simple, scannable format the
  // classic view uses. We don't reuse BlockRenderer here because the
  // sheet's contrast / sizing is darker and tighter.
  const sections = useMemo(() => collapseBlocks(step.blocks, step.bodyMarkdown), [step]);
  return (
    <>
      <div
        className="vja-reel-sheet-backdrop"
        data-open={open ? 'true' : 'false'}
        onClick={onClose}
        aria-hidden
      />
      <aside
        id={id}
        className="vja-reel-sheet"
        data-open={open ? 'true' : 'false'}
        role="dialog"
        aria-modal="false"
        aria-label={step.title}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="vja-reel-sheet-handle" aria-hidden />
        <header className="vja-reel-sheet-header">
          <h3 className="vja-reel-sheet-title">{step.title}</h3>
          <button
            type="button"
            className="vja-reel-sheet-close"
            onClick={onClose}
            aria-label="Close details"
          >
            <ChevronDown size={18} strokeWidth={2.5} />
          </button>
        </header>
        <div className="vja-reel-sheet-body">
          {sections.length === 0 && (
            <p className="vja-reel-sheet-empty">
              No additional text for this step — follow the video and the voiceover.
            </p>
          )}
          {sections.map((sec, i) => {
            if (sec.kind === 'text') {
              return (
                <div key={i} className="markdown-body vja-reel-sheet-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{sec.markdown}</ReactMarkdown>
                </div>
              );
            }
            if (sec.kind === 'list') {
              return sec.ordered ? (
                <ol key={i} className="vja-reel-sheet-list">
                  {sec.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ol>
              ) : (
                <ul key={i} className="vja-reel-sheet-list">
                  {sec.items.map((it, j) => (
                    <li key={j}>{it}</li>
                  ))}
                </ul>
              );
            }
            if (sec.kind === 'callout') {
              return (
                <div
                  key={i}
                  className={`vja-reel-sheet-callout vja-reel-sheet-callout--${sec.tone}`}
                >
                  {sec.title && <strong>{sec.title}</strong>}
                  <span>{sec.text}</span>
                </div>
              );
            }
            if (sec.kind === 'kv') {
              return (
                <table key={i} className="vja-reel-sheet-kv">
                  <thead>
                    <tr>
                      <th>{sec.columns[0]}</th>
                      <th>{sec.columns[1]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sec.rows.map(([k, v], j) => (
                      <tr key={j}>
                        <td>{k}</td>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            }
            return null;
          })}
        </div>
      </aside>
    </>
  );
}

// Flatten the typed blocks (and fallback bodyMarkdown) into a sequence
// of render-ready sheet sections. Lets the renderer above stay declarative
// without re-deriving block kinds at render time.
type SheetSection =
  | { kind: 'text'; markdown: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'callout'; tone: 'safety' | 'warning' | 'tip' | 'note'; title?: string; text: string }
  | { kind: 'kv'; columns: [string, string]; rows: Array<[string, string]> };

// Lightweight markdown stripper for preview snippets. We render preview
// text inside a line-clamped paragraph (no markdown parser), so we need
// the raw words without `**emphasis**`, `[link](href)`, or heading marks
// leaking through. This is deliberately not a full parser — it handles
// the inline marks our authoring UI produces and leaves anything exotic
// (raw HTML, footnotes) close enough to display as preview.
function stripMarkdownInline(input: string): string {
  return input
    // images first so their alt text doesn't survive the link pass below
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // links → keep just the link text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // code spans → drop the backticks but keep the inner text
    .replace(/`([^`]+)`/g, '$1')
    // emphasis / strikethrough / heading markers
    .replace(/[*_~]+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    // block-quote prefix
    .replace(/^\s*>\s?/gm, '')
    // collapse whitespace including the newlines we just exposed
    .replace(/\s+/g, ' ')
    .trim();
}

// First-block preview for the text-only reel layout. Returns the most
// representative slice of the step's body — first paragraph, first few
// list items, or callout text — stripped to plain text. Tables and
// inline photos don't preview well in a centered card, so we skip them
// and check the next block. Returns '' when there's nothing to show
// (the caller renders a different CTA in that case).
function extractPreviewText(
  blocks: StepBlock[] | undefined,
  bodyMarkdown: string | null | undefined,
): string {
  if (blocks && blocks.length > 0) {
    for (const b of blocks) {
      switch (b.kind) {
        case 'paragraph': {
          const t = stripMarkdownInline(b.text);
          if (t) return t;
          break;
        }
        case 'bullet_list':
        case 'numbered_list': {
          if (b.items.length > 0) {
            return b.items
              .slice(0, 3)
              .map(stripMarkdownInline)
              .filter(Boolean)
              .join(' · ');
          }
          break;
        }
        case 'callout': {
          const head = b.title ? `${b.title}: ` : '';
          const t = stripMarkdownInline(b.text);
          if (t) return `${head}${t}`;
          break;
        }
        case 'key_value':
        case 'photo_inline':
          // Don't preview tables or inline photos — they need their own
          // surface to be useful. Fall through to the next block.
          break;
      }
    }
  }
  if (bodyMarkdown && bodyMarkdown.trim()) {
    return stripMarkdownInline(bodyMarkdown);
  }
  return '';
}

function collapseBlocks(
  blocks: StepBlock[] | undefined,
  bodyMarkdown: string | null | undefined,
): SheetSection[] {
  if (blocks && blocks.length > 0) {
    const out: SheetSection[] = [];
    for (const b of blocks) {
      switch (b.kind) {
        case 'paragraph':
          if (b.text.trim()) out.push({ kind: 'text', markdown: b.text });
          break;
        case 'bullet_list':
          if (b.items.length > 0) out.push({ kind: 'list', ordered: false, items: b.items });
          break;
        case 'numbered_list':
          if (b.items.length > 0) out.push({ kind: 'list', ordered: true, items: b.items });
          break;
        case 'callout':
          out.push({ kind: 'callout', tone: b.tone, title: b.title, text: b.text });
          break;
        case 'key_value':
          out.push({ kind: 'kv', columns: b.columns, rows: b.rows });
          break;
        case 'photo_inline':
          // The video / first image already conveys the visual; an
          // additional inline photo in the text sheet would duplicate
          // it visually for marginal value. Skip.
          break;
      }
    }
    return out;
  }
  if (bodyMarkdown && bodyMarkdown.trim()) {
    return [{ kind: 'text', markdown: bodyMarkdown }];
  }
  return [];
}
