'use client';

import { useEffect, useRef, useState } from 'react';

// FieldSupport intro splash. Mounts only when the URL carries ?intro=1;
// the /q/<code> route handler sets that flag on QR scans, so the splash
// plays on first arrival without replaying on refresh or back navigation.
//
// The hub content underneath is fully mounted while the splash runs. The
// overlay provides the brand transition and then gets out of the way.
export function SplashIntro() {
  const [phase, setPhase] = useState<'enter' | 'hold' | 'exit' | 'done'>('enter');
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Strip ?intro=1 from the URL immediately so a refresh mid-animation
    // doesn't trigger the splash again. Use replaceState so this doesn't
    // add a history entry the back button has to step through.
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

    // Stagger the phases. enter gives the browser one paint, hold runs
    // the logo reveal and circuit pulses, exit fades the overlay, then
    // done unmounts it.
    const t1 = window.setTimeout(() => setPhase('hold'), 90);
    const t2 = window.setTimeout(() => setPhase('exit'), 2550);
    const t3 = window.setTimeout(() => setPhase('done'), 3150);

    // Play a soft two-note chime via WebAudio. No audio asset to bundle.
    // Wrapped in try/catch because autoplay policy may block on some
    // browsers if the QR-tap gesture didn't propagate; the visual
    // intro still runs in that case.
    void playChime().catch(() => {
      /* autoplay blocked — silent intro is fine */
    });

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, []);

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
    </div>
  );
}

// Synthesized chime — a soft two-note bell (perfect-fifth interval,
// E5 → B5) with a quick decay envelope. Generated with WebAudio so we
// don't have to ship an audio file, and so the user can't accidentally
// disable it via missing-asset 404.
async function playChime(): Promise<void> {
  if (typeof window === 'undefined') return;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  // iOS / strict autoplay: resume in case it created the context suspended.
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* fall through — the oscillator schedule will be silent but harmless */
    }
  }
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);

  const tone = (freq: number, start: number, dur: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now + start);
    g.gain.linearRampToValueAtTime(1, now + start + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.05);
  };

  // E5 → B5 (perfect fifth) — bright but not piercing. Second note
  // overlaps the tail of the first so the two ring together briefly.
  tone(659.25, 0.0, 1.2);
  tone(987.77, 0.18, 1.4);

  // Auto-close the context after the chime ends so we don't leave an
  // open AudioContext lingering on the page.
  window.setTimeout(() => {
    void ctx.close().catch(() => {});
  }, 1800);
}
