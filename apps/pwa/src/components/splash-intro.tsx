'use client';

import { useEffect, useRef, useState } from 'react';

// FieldSupport intro splash. Mounts only when the URL carries ?intro=1;
// the /q/<code> route handler sets that flag on QR scans, so the splash
// plays on first arrival without replaying on refresh or back navigation.
//
// The hub content underneath is fully mounted while the splash runs. The
// overlay reveals the FieldSupport logo (PNG asset) with a scan sweep,
// pulsing red nodes, and an underline trace, then fades away.
//
// View gating (per-device, via localStorage):
//   • After SPLASH_VIEW_THRESHOLD complete plays the animation skips
//     entirely — the splash becomes friction on the 20th scan, even if
//     it's delightful on the 1st.
//   • The intro WAV plays on every splash within that threshold; once
//     the threshold cap skips the visual, no audio either.
//
// Skip affordance: a "Skip" pill fades in 1.5s after the animation
// starts so an impatient viewer can advance without waiting through the
// full sequence.
//
// Reset for development: `localStorage.removeItem('fs:splash:plays')`.

const SPLASH_PLAYS_KEY = 'fs:splash:plays';
const SPLASH_VIEW_THRESHOLD = 3;

function getSplashPlays(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(SPLASH_PLAYS_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
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
    clearTimers();
    stopAudio();
    setPhase('exit');
    const t = window.setTimeout(() => setPhase('done'), 280);
    timersRef.current = [t];
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

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

    if (plays >= SPLASH_VIEW_THRESHOLD) {
      setPhase('done');
      incrementSplashPlays();
      return;
    }

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

    // Phase timing (~3.15s total).
    //   enter (0–90ms)     paint the overlay before any animation kicks.
    //   hold  (90–2550ms)  run logo reveal + circuit pulses.
    //   exit  (2550–3150)  fade the overlay back out.
    const t1 = window.setTimeout(() => setPhase('hold'), 90);
    const t2 = window.setTimeout(() => setPhase('exit'), 2550);
    const t3 = window.setTimeout(() => setPhase('done'), 3150);
    const t4 = window.setTimeout(() => setShowSkip(true), 1500);
    timersRef.current = [t1, t2, t3, t4];

    // Audio runs alongside the visual on every play within the threshold.
    // The catch swallows autoplay rejections — browsers may block audio
    // when the splash mounts after a same-origin redirect from /q/<code>
    // if the original gesture is considered stale; the visual still
    // runs in that case.
    void playIntroSound(audioRef).catch(() => {
      /* autoplay blocked — silent intro is fine */
    });

    return () => {
      clearTimers();
      stopAudio();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'done') return;
    if (!animatedRef.current) return;
    if (incrementedRef.current) return;
    incrementedRef.current = true;
    incrementSplashPlays();
  }, [phase]);

  if (phase === 'done') return null;

  return (
    <div className="splash-intro" data-phase={phase} role="presentation" aria-hidden="true">
      <div className="splash-intro-stage">
        <span className="splash-intro-scan" aria-hidden="true" />
        <div className="splash-intro-logo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/field-support-intro.png"
            alt=""
            className="splash-intro-logo"
            draggable={false}
          />
          <span className="splash-intro-red-wake" aria-hidden="true" />
          <span className="splash-intro-shine" aria-hidden="true" />
          <span className="splash-intro-node splash-intro-node-a" aria-hidden="true" />
          <span className="splash-intro-node splash-intro-node-b" aria-hidden="true" />
          <span className="splash-intro-node splash-intro-node-c" aria-hidden="true" />
        </div>
        <span className="splash-intro-underline" aria-hidden="true" />
      </div>
      <button
        type="button"
        className="splash-intro-skip"
        data-visible={showSkip ? 'true' : 'false'}
        onClick={skipSplash}
        aria-label="Skip intro"
      >
        Skip
      </button>
    </div>
  );
}

async function playIntroSound(ref: React.MutableRefObject<HTMLAudioElement | null>): Promise<void> {
  if (typeof window === 'undefined') return;
  const audio = new Audio('/intro-sound.wav');
  audio.preload = 'auto';
  audio.volume = 0.85;
  ref.current = audio;
  await audio.play();
}
