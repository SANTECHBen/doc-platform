'use client';

import { useEffect, useRef, useState } from 'react';

// FieldSupport intro splash. Mounts only when the URL carries ?intro=1;
// the /q/<code> route handler sets that flag on QR scans, so the splash
// plays on first arrival without replaying on refresh or back navigation.
//
// View gating (per-device, via localStorage):
//   • Play 1                     — full 5.3s reveal (gear → traces →
//                                  nodes → wordmark → underline). Intro
//                                  WAV plays only here.
//   • Plays 2, 3                 — condensed ~2s variant: wordmark only,
//                                  no audio. Brand identity survives
//                                  without the full theatre.
//   • Plays SPLASH_VIEW_THRESHOLD+  — skipped entirely. The splash becomes
//                                  friction on the 20th scan.
//
// Skip affordance: a small "Skip" pill fades in 1.5s (full) / 600ms
// (condensed) after the animation starts. Available to everyone — even
// the first-time viewer gets an escape hatch.
//
// Reset for development: `localStorage.removeItem('fs:splash:plays')`.
//
// Theme: the splash is canonically a white-background brand moment
// regardless of the user's app theme preference, so the root element
// declares data-theme="light". CSS custom properties cascade — every
// fill/stroke inside the SVG resolves to the light token even when
// the document has data-theme="dark".

const SPLASH_PLAYS_KEY = 'fs:splash:plays';
const SPLASH_VIEW_THRESHOLD = 3;

// Phase timing differs by variant. Full runs the full gear/circuit/
// wordmark reveal at the original tempo; condensed strips to wordmark
// only at ~2s.
const PHASE_TIMING_FULL = {
  hold: 80,
  exit: 4660,
  done: 5300,
  skipBtn: 1500,
};
const PHASE_TIMING_CONDENSED = {
  hold: 80,
  exit: 1700,
  done: 2080,
  skipBtn: 600,
};

// SVG viewBox per variant. Full shows the whole 940x240 composition.
// Condensed zooms into the wordmark area so it sits centered in the
// viewport rather than the right-third of the full viewBox.
const VIEWBOX_FULL = '0 0 940 240';
const VIEWBOX_CONDENSED = '380 110 480 140';

type Variant = 'full' | 'condensed';

function getSplashPlays(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(SPLASH_PLAYS_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    // Safari in private mode and locked-down enterprise browsers throw on
    // localStorage access. Falling through to 0 means the splash plays
    // every time for these users — acceptable, since the show is short
    // and they're a small minority.
    return 0;
  }
}

function incrementSplashPlays(): void {
  if (typeof window === 'undefined') return;
  try {
    const cur = getSplashPlays();
    window.localStorage.setItem(SPLASH_PLAYS_KEY, String(cur + 1));
  } catch {
    /* localStorage unavailable — ignore */
  }
}

export function SplashIntro() {
  const [phase, setPhase] = useState<'enter' | 'hold' | 'exit' | 'done'>('enter');
  const [variant, setVariant] = useState<Variant>('full');
  const [showSkip, setShowSkip] = useState(false);
  const startedRef = useRef(false);
  const animatedRef = useRef(false);
  const incrementedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timersRef = useRef<number[]>([]);

  function clearTimers() {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  }

  function stopAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.src = '';
      audio.load();
    } catch {
      /* element may already be detached */
    }
    audioRef.current = null;
  }

  function skipSplash() {
    // User-initiated skip. Cancel running timers, stop audio
    // immediately, and play a brief 280ms exit fade rather than
    // disappearing instantly — abrupt cuts feel like a glitch.
    clearTimers();
    stopAudio();
    setPhase('exit');
    const t = window.setTimeout(() => setPhase('done'), 280);
    timersRef.current = [t];
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Strip ?intro=1 from the URL immediately so a refresh mid-animation
    // doesn't trigger the splash again, and so a shared link that happens
    // to carry the flag doesn't replay it for someone who didn't scan.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (url.searchParams.has('intro')) {
        url.searchParams.delete('intro');
        window.history.replaceState(
          window.history.state,
          '',
          url.pathname + (url.search ? url.search : '') + url.hash,
        );
      }
    }

    const plays = getSplashPlays();

    // After N complete plays this device has earned the right to skip
    // the show. Hand off to the hub on the same frame — no animation,
    // no sound. The threshold-gate increment in this branch keeps the
    // count incrementing (useful for telemetry / future tuning).
    if (plays >= SPLASH_VIEW_THRESHOLD) {
      setPhase('done');
      incrementSplashPlays();
      return;
    }

    // Respect prefers-reduced-motion — skip the show, just hand off.
    // We still count this as a "play" so a user who later turns motion
    // back on doesn't suddenly start seeing the full sequence after
    // having already used the app extensively.
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      const t = window.setTimeout(() => {
        setPhase('done');
        incrementSplashPlays();
        incrementedRef.current = true;
      }, 360);
      timersRef.current = [t];
      return () => clearTimers();
    }

    animatedRef.current = true;

    // Variant selection. First play = full reveal (the brand-identity
    // moment). Plays 2-3 = condensed (just the wordmark) so a tech
    // who scans three machines in a row doesn't sit through three full
    // shows. The threshold check above already handled plays 4+.
    const playVariant: Variant = plays === 0 ? 'full' : 'condensed';
    setVariant(playVariant);
    const timing = playVariant === 'condensed' ? PHASE_TIMING_CONDENSED : PHASE_TIMING_FULL;

    const t1 = window.setTimeout(() => setPhase('hold'), timing.hold);
    const t2 = window.setTimeout(() => setPhase('exit'), timing.exit);
    const t3 = window.setTimeout(() => setPhase('done'), timing.done);
    // Skip pill fades in only after the initial reveal so first-time
    // viewers get the show before being offered an escape hatch. The
    // condensed variant's skip pill appears faster since the whole
    // reveal is shorter.
    const t4 = window.setTimeout(() => setShowSkip(true), timing.skipBtn);
    timersRef.current = [t1, t2, t3, t4];

    // Sound only ever plays on the FIRST scan ever. Plays 2-3 (which
    // already get the condensed visual) stay silent — the WAV is a
    // delight on first scan and noise on repeat scans.
    if (plays === 0) {
      void playIntroSound(audioRef).catch(() => {
        /* autoplay blocked — silent intro is fine */
      });
    }

    return () => {
      clearTimers();
      stopAudio();
    };
  }, []);

  // Increment the play count exactly once, the first time we reach the
  // 'done' phase after actually animating. Guarded so threshold-skipped
  // and reduced-motion mounts don't double-count.
  useEffect(() => {
    if (phase !== 'done') return;
    if (!animatedRef.current) return;
    if (incrementedRef.current) return;
    incrementedRef.current = true;
    incrementSplashPlays();
  }, [phase]);

  if (phase === 'done') return null;

  return (
    <div
      className="fs-splash"
      data-phase={phase}
      data-variant={variant}
      data-theme="light"
      role="presentation"
      aria-hidden="true"
    >
      <div className="fs-splash-vignette" aria-hidden="true" />
      <div className="fs-splash-stage">
        <FieldSupportMarkSVG variant={variant} />
      </div>
      {/* Skip pill — visible only after the initial reveal so a
          first-time viewer still gets the show. Always rendered (not
          conditionally mounted) so the CSS fade-in animation runs
          smoothly via the data-visible attribute instead of a mount
          transition. */}
      <button
        type="button"
        className="fs-splash-skip"
        data-visible={showSkip ? 'true' : 'false'}
        onClick={skipSplash}
        aria-label="Skip intro"
      >
        Skip
      </button>
    </div>
  );
}

// Inline SVG so each part can be animated individually via CSS classes.
// All color values resolve from CSS custom properties (forced light
// theme on the parent .fs-splash element) so the splash adopts the
// canonical brand palette without hard-coded hex literals. This also
// means future OEM-co-branded splashes only need to inject brand
// custom properties on a parent element.
function FieldSupportMarkSVG({ variant }: { variant: Variant }) {
  return (
    <svg
      className="fs-mark"
      viewBox={variant === 'condensed' ? VIEWBOX_CONDENSED : VIEWBOX_FULL}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="fsBrandBlue" x1="480" x2="900" y1="86" y2="146" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'rgb(var(--brand))' }} />
          <stop offset="1" style={{ stopColor: 'rgb(var(--brand-strong))' }} />
        </linearGradient>
        <linearGradient id="fsTraceSteel" x1="80" x2="540" y1="60" y2="118" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'rgb(var(--ink-primary))' }} />
          <stop offset="0.58" style={{ stopColor: 'rgb(var(--ink-secondary))' }} />
          <stop offset="1" style={{ stopColor: 'rgb(var(--ink-tertiary))' }} />
        </linearGradient>
        <radialGradient id="fsGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: 'rgb(var(--brand))' }} stopOpacity="0.45" />
          <stop offset="60%" style={{ stopColor: 'rgb(var(--brand))' }} stopOpacity="0.08" />
          <stop offset="100%" style={{ stopColor: 'rgb(var(--brand))' }} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Soft cyan-blue glow behind the gear. Fades up first, fades back
          down after the wordmark has landed. */}
      <circle className="fs-glow" cx="125" cy="118" r="135" fill="url(#fsGlow)" />

      {/* Gear assembly — teeth + dark body + light face + arc highlights. */}
      <g className="fs-gear" style={{ transformOrigin: '125px 118px' }}>
        <g className="fs-gear-teeth" style={{ fill: 'rgb(var(--ink-primary))' }}>
          {Array.from({ length: 16 }).map((_, i) => (
            <rect
              key={i}
              x="117"
              y="18"
              width="16"
              height="28"
              rx="2"
              transform={`rotate(${i * 22.5} 125 118)`}
            />
          ))}
        </g>
        <circle cx="125" cy="118" r="70" style={{ fill: 'rgb(var(--ink-primary))' }} />
        <circle cx="125" cy="118" r="52" style={{ fill: 'rgb(var(--surface-base))' }} />
        <path
          d="M125 72a46 46 0 0 0-34.2 76.7"
          fill="none"
          style={{ stroke: 'rgb(var(--ink-secondary))' }}
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M125 86a32 32 0 0 0-24.4 53"
          fill="none"
          style={{ stroke: 'rgb(var(--ink-primary))' }}
          strokeWidth="6"
          strokeLinecap="round"
        />
      </g>

      {/* Circuit traces — drawn left-to-right via stroke-dashoffset. The
          three paths are individually animated and overlap so the result
          reads as a single wiring diagram coming online. */}
      <g
        className="fs-traces"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className="fs-trace fs-trace-a"
          d="M154 155h118l34-34h78l30-29h94"
          stroke="url(#fsTraceSteel)"
          strokeWidth="13"
        />
        <path
          className="fs-trace fs-trace-b"
          d="M158 176h130l34-31h78l29-27h94"
          style={{ stroke: 'rgb(var(--ink-secondary))' }}
          strokeWidth="9"
        />
        <path
          className="fs-trace fs-trace-c"
          d="M207 134h68l27-25h86"
          style={{ stroke: 'rgb(var(--ink-primary))' }}
          strokeWidth="8"
        />
        <path
          className="fs-trace fs-trace-red"
          d="M211 134h38"
          style={{ stroke: 'rgb(var(--signal-fault))' }}
          strokeWidth="7"
        />
        <path
          className="fs-trace fs-trace-blue-a"
          d="M323 145h68"
          style={{ stroke: 'rgb(var(--brand))' }}
          strokeWidth="7"
        />
        <path
          className="fs-trace fs-trace-blue-b"
          d="M415 118h58"
          style={{ stroke: 'rgb(var(--brand))' }}
          strokeWidth="6"
        />
      </g>

      {/* Connector dots. Pop on sequentially after the traces finish. */}
      <g className="fs-nodes">
        <g className="fs-node fs-node-1">
          <circle cx="391" cy="146" r="16" style={{ fill: 'rgb(var(--surface-base))' }} />
          <circle cx="391" cy="146" r="11.5" style={{ fill: 'rgb(var(--brand))' }} />
          <circle cx="391" cy="146" r="5.5" style={{ fill: 'rgb(var(--surface-base))' }} opacity="0.92" />
        </g>
        <g className="fs-node fs-node-2">
          <circle cx="473" cy="118" r="15" style={{ fill: 'rgb(var(--surface-base))' }} />
          <circle cx="473" cy="118" r="10.5" style={{ fill: 'rgb(var(--brand))' }} />
          <circle cx="473" cy="118" r="5.5" style={{ fill: 'rgb(var(--surface-base))' }} opacity="0.92" />
        </g>
        <g className="fs-node fs-node-3">
          <circle cx="523" cy="118" r="14" style={{ fill: 'rgb(var(--surface-base))' }} />
          <circle cx="523" cy="118" r="9.5" style={{ fill: 'rgb(var(--signal-fault))' }} />
          <circle cx="523" cy="118" r="4.5" style={{ fill: 'rgb(var(--surface-base))' }} opacity="0.92" />
        </g>
      </g>

      {/* Wordmark — italic Field + Support. Skew matches the static SVG.
          Translated as a group so the rise-in keeps the kerning crisp. */}
      <g className="fs-wordmark" transform="skewX(-10)">
        <text
          x="425"
          y="194"
          style={{ fill: 'rgb(var(--ink-primary))' }}
          fontFamily="IBM Plex Sans, Inter, Arial, sans-serif"
          fontSize="76"
          fontStyle="italic"
          fontWeight={700}
          letterSpacing="-4"
        >
          Field
        </text>
        <text
          x="588"
          y="194"
          fill="url(#fsBrandBlue)"
          fontFamily="IBM Plex Sans, Inter, Arial, sans-serif"
          fontSize="76"
          fontStyle="italic"
          fontWeight={800}
          letterSpacing="-4.5"
        >
          Support
        </text>
      </g>

      {/* Two understroke swoops, drawn last after the wordmark lands. */}
      <g className="fs-underline">
        <path
          className="fs-underline-line"
          d="M84 220c143-6 314-5 492 1 125 4 244 2 363-11"
          fill="none"
          style={{ stroke: 'rgb(var(--ink-primary))' }}
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.65"
        />
        <path
          className="fs-underline-red"
          d="M338 232c95 6 189 9 282 6 88-3 180-10 293-23-91 16-187 27-286 32-102 5-199 0-289-15Z"
          style={{ fill: 'rgb(var(--signal-fault))' }}
          opacity="0.95"
        />
        <path
          className="fs-underline-blue"
          d="M422 231c99 5 193 4 282-3 77-6 147-14 207-24-70 16-144 27-222 34-84 8-173 6-267-7Z"
          style={{ fill: 'rgb(var(--brand))' }}
          opacity="0.3"
        />
      </g>
    </svg>
  );
}

// Play the production intro sound. Returns once playback is started (or
// rejects if autoplay was blocked, in which case the visual still runs).
// The element is stashed on a ref so the cleanup function in the host
// effect can pause + release it if the splash unmounts early.
async function playIntroSound(ref: React.MutableRefObject<HTMLAudioElement | null>): Promise<void> {
  if (typeof window === 'undefined') return;
  const audio = new Audio('/intro-sound.wav');
  audio.preload = 'auto';
  audio.volume = 0.85;
  ref.current = audio;
  await audio.play();
}
