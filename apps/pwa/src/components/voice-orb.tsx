'use client';

import { useEffect, useRef } from 'react';

// VoiceOrb — ChatGPT-voice-style animated orb. Pure canvas (no SVG/3D libs)
// so it stays smooth on mid-tier mobile. Four states drive distinct moods:
//
//   idle      — slow breathing pulse, low saturation
//   listening — amplitude-reactive scale + cyan tint, mic analyser drives it
//   thinking  — slow rotating shimmer + violet tint, no audio input
//   speaking  — amplitude-reactive scale + brand glow, TTS analyser drives it
//
// `analyser` is an optional WebAudio AnalyserNode; when supplied, the orb
// samples its RMS each frame and feeds it into the scale. When absent, the
// orb falls back to a deterministic time-based wave so it never sits still.

export type VoiceOrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: VoiceOrbState;
  analyser?: AnalyserNode | null;
  size?: number;
  className?: string;
}

export function VoiceOrb({ state, analyser, size = 280, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Smoothed amplitude — keeps the orb from jittering on every frame even
  // when the analyser is noisy. Updated inside the rAF loop.
  const ampRef = useRef(0);
  const stateRef = useRef<VoiceOrbState>(state);
  const analyserRef = useRef<AnalyserNode | null>(analyser ?? null);

  // Mirror props into refs so the rAF loop sees the latest without
  // re-binding the loop on every render.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    analyserRef.current = analyser ?? null;
  }, [analyser]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.scale(dpr, dpr);

    const center = size / 2;
    const baseRadius = size * 0.32;

    // Read brand color from CSS so the orb stays themed with the OEM palette
    // when one is configured. Defaults to white-hot if --brand isn't set.
    const cssVar = (name: string, fallback: string) => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return v || fallback;
    };
    const brand = cssVar('--brand', '247 117 49'); // RGB triplet

    let raf = 0;
    let t0 = performance.now();
    // Allocate a sized backing buffer so the typed array is concretely
    // Uint8Array<ArrayBuffer>, which is what AnalyserNode expects (lib.dom
    // typings reject ArrayBufferLike unions in strict mode).
    const fftBuf = new ArrayBuffer(1024);
    const fft = new Uint8Array(fftBuf);

    const sampleAmplitude = (): number => {
      const an = analyserRef.current;
      if (!an) return 0;
      try {
        const N = Math.min(fft.length, an.frequencyBinCount);
        an.getByteTimeDomainData(fft);
        let sum = 0;
        for (let i = 0; i < N; i++) {
          const v = (fft[i]! - 128) / 128;
          sum += v * v;
        }
        return Math.sqrt(sum / N);
      } catch {
        return 0;
      }
    };

    // Multiply an "r g b" triplet by a scalar to get a darker variant for
    // the rim. Keeps the orb tinted by the OEM brand color without a second
    // CSS variable to wire.
    const tint = (rgb: string, factor: number): string => {
      const parts = rgb.split(/\s+/).map((n) => Number(n));
      if (parts.length !== 3) return rgb;
      return parts
        .map((c) => Math.max(0, Math.min(255, Math.round(c * factor))))
        .join(' ');
    };

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const s = stateRef.current;

      // Per-state palette. Each state gets a hi (specular), a hue (mid-body
      // saturation), and an implicit dark rim derived from the hue.
      let inner = '255 255 255';
      let hue = brand;
      switch (s) {
        case 'idle':
          inner = '255 255 255';
          hue = brand;
          break;
        case 'listening':
          inner = '210 245 255';
          hue = '60 170 255'; // tighter, more saturated cyan
          break;
        case 'thinking':
          inner = '235 220 255';
          hue = '140 90 255'; // saturated violet
          break;
        case 'speaking':
          inner = '255 245 230';
          hue = brand;
          break;
      }
      const rim = tint(hue, 0.55); // deeper version of hue — pulls edge in
      const aura = tint(hue, 0.85); // slightly muted hue for the soft halo

      // Amplitude — analyser when available, else a deterministic wave that
      // gives idle/thinking life without microphone input. 'speaking' on
      // iOS plays via HTMLAudioElement (no analyser tap possible without
      // re-routing audio to the earpiece bus), so we pulse procedurally.
      const measured = sampleAmplitude();
      const hasAnalyser = analyserRef.current !== null;
      let target: number;
      if (s === 'listening' || s === 'speaking') {
        if (hasAnalyser) {
          target = Math.min(1, measured * 4); // scale up — typical RMS ≈ 0.05–0.25
        } else if (s === 'speaking') {
          // Synthesized "talking" cadence — mixed sines feel more like speech
          // than a single sine wave.
          target =
            0.32 +
            0.22 * Math.abs(Math.sin(t * 5.2)) +
            0.14 * Math.abs(Math.sin(t * 7.1 + 0.7));
        } else {
          target = 0;
        }
      } else if (s === 'thinking') {
        target = 0.22 + 0.08 * Math.sin(t * 1.6);
      } else {
        target = 0.12 + 0.06 * Math.sin(t * 0.9); // idle breathing
      }

      const k = target > ampRef.current ? 0.35 : 0.08;
      ampRef.current = ampRef.current + (target - ampRef.current) * k;
      const amp = ampRef.current;

      ctx.clearRect(0, 0, size, size);

      // ------------------------------------------------------------------
      // Layer 1 — outer aura. Tight (≈1.3× core radius max) and dim.
      //   The previous version filled most of the canvas; that's what made
      //   it read as a watercolor blob. Two layers, both inside ~70% of the
      //   canvas, give a clean halo without bleed.
      // ------------------------------------------------------------------
      const haloLayers: Array<{ r: number; a: number; phase: number }> = [
        { r: baseRadius * (1.32 + amp * 0.35), a: 0.16, phase: 0 },
        { r: baseRadius * (1.14 + amp * 0.25), a: 0.26, phase: 1.7 },
      ];
      for (const h of haloLayers) {
        const wobble = 1 + 0.03 * Math.sin(t * 1.2 + h.phase);
        const r = h.r * wobble;
        const g = ctx.createRadialGradient(center, center, baseRadius * 0.78, center, center, r);
        g.addColorStop(0, `rgba(${aura} / ${h.a})`);
        g.addColorStop(0.55, `rgba(${aura} / ${h.a * 0.45})`);
        g.addColorStop(1, `rgba(${aura} / 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(center, center, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ------------------------------------------------------------------
      // Layer 2 — core. Saturation HOLDS to ~85% of the radius and only
      // rolls off in the last 15%. That's what gives the "glass marble"
      // edge instead of a fade. The dark rim color at 92-100% is what your
      // eye reads as a defined boundary.
      // ------------------------------------------------------------------
      const coreR = baseRadius * (0.96 + amp * 0.18);
      const coreGrad = ctx.createRadialGradient(
        center - coreR * 0.18,
        center - coreR * 0.22,
        0,
        center,
        center,
        coreR,
      );
      coreGrad.addColorStop(0, `rgba(${inner} / 1.0)`);
      coreGrad.addColorStop(0.18, `rgba(${inner} / 0.92)`);
      coreGrad.addColorStop(0.5, `rgba(${hue} / 1.0)`);
      coreGrad.addColorStop(0.85, `rgba(${hue} / 0.95)`);
      coreGrad.addColorStop(0.97, `rgba(${rim} / 0.85)`);
      coreGrad.addColorStop(1.0, `rgba(${rim} / 0)`);
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(center, center, coreR, 0, Math.PI * 2);
      ctx.fill();

      // ------------------------------------------------------------------
      // Layer 3 — specular catch-light. Sharper falloff (gradient peaks
      // brighter, fades faster) than before so it reads as a clean glass
      // highlight, not a wash. Slow drift on the offset.
      // ------------------------------------------------------------------
      const hiR = coreR * 0.42;
      const hiX = center - coreR * (0.28 + 0.03 * Math.sin(t * 0.7));
      const hiY = center - coreR * (0.34 + 0.03 * Math.cos(t * 0.7));
      const hiGrad = ctx.createRadialGradient(hiX, hiY, 0, hiX, hiY, hiR);
      hiGrad.addColorStop(0, 'rgba(255 255 255 / 0.95)');
      hiGrad.addColorStop(0.35, 'rgba(255 255 255 / 0.45)');
      hiGrad.addColorStop(0.7, 'rgba(255 255 255 / 0.08)');
      hiGrad.addColorStop(1, 'rgba(255 255 255 / 0)');
      ctx.fillStyle = hiGrad;
      ctx.beginPath();
      ctx.arc(hiX, hiY, hiR, 0, Math.PI * 2);
      ctx.fill();

      // ------------------------------------------------------------------
      // Layer 4 — small lower-right rim shimmer. A second, much smaller
      // highlight on the opposite side of the orb gives it a sense of
      // dimensionality without looking like noise.
      // ------------------------------------------------------------------
      const rimR = coreR * 0.18;
      const rimX = center + coreR * (0.42 + 0.02 * Math.sin(t * 0.5));
      const rimY = center + coreR * (0.46 + 0.02 * Math.cos(t * 0.5));
      const rimGrad = ctx.createRadialGradient(rimX, rimY, 0, rimX, rimY, rimR);
      rimGrad.addColorStop(0, `rgba(${inner} / 0.55)`);
      rimGrad.addColorStop(1, `rgba(${inner} / 0)`);
      ctx.fillStyle = rimGrad;
      ctx.beginPath();
      ctx.arc(rimX, rimY, rimR, 0, Math.PI * 2);
      ctx.fill();

      // ------------------------------------------------------------------
      // Layer 5 — thinking arc. Same as before, just radius pulled in.
      // ------------------------------------------------------------------
      if (s === 'thinking') {
        const ringR = baseRadius * 1.08;
        const headAngle = (t * 1.4) % (Math.PI * 2);
        const arcLen = Math.PI * 1.2;
        for (let i = 0; i < 60; i++) {
          const f = i / 60;
          const a = headAngle - f * arcLen;
          const x = center + Math.cos(a) * ringR;
          const y = center + Math.sin(a) * ringR;
          ctx.fillStyle = `rgba(${hue} / ${(1 - f) * 0.7})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.6 + (1 - f) * 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      // Hint the browser to composite this on its own layer — keeps the
      // orb buttery during route transitions.
      style={{ willChange: 'transform' }}
      aria-hidden
    />
  );
}
