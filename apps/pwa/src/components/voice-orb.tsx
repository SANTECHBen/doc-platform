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

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const s = stateRef.current;

      // Per-state colors. RGB triplets ("r g b") so we can compose alpha.
      let inner = '255 255 255';
      let outerHue = brand;
      switch (s) {
        case 'idle':
          inner = '255 255 255';
          outerHue = brand;
          break;
        case 'listening':
          inner = '180 240 255';
          outerHue = '90 200 255'; // cyan
          break;
        case 'thinking':
          inner = '230 215 255';
          outerHue = '160 110 255'; // violet
          break;
        case 'speaking':
          inner = '255 240 220';
          outerHue = brand;
          break;
      }

      // Amplitude — analyser when available, else a deterministic wave that
      // gives idle/thinking life without microphone input.
      const measured = sampleAmplitude();
      const target =
        s === 'listening' || s === 'speaking'
          ? Math.min(1, measured * 4) // scale up — typical RMS ≈ 0.05–0.25
          : s === 'thinking'
            ? 0.25 + 0.1 * Math.sin(t * 1.6)
            : 0.15 + 0.08 * Math.sin(t * 0.9); // idle breathing

      // Critically damped follower — fast attack, gentle release.
      const k = target > ampRef.current ? 0.35 : 0.08;
      ampRef.current = ampRef.current + (target - ampRef.current) * k;
      const amp = ampRef.current;

      // Background — fully clear so the overlay's backdrop shows through.
      ctx.clearRect(0, 0, size, size);

      // Outer aura — three concentric blurred halos at offset phases. Adds
      // organic life without per-pixel noise.
      const haloLayers: Array<{ r: number; a: number; phase: number }> = [
        { r: baseRadius * (1.9 + amp * 0.6), a: 0.18, phase: 0 },
        { r: baseRadius * (1.55 + amp * 0.5), a: 0.28, phase: 1.7 },
        { r: baseRadius * (1.25 + amp * 0.4), a: 0.42, phase: 3.4 },
      ];
      for (const h of haloLayers) {
        const wobble = 1 + 0.04 * Math.sin(t * 1.2 + h.phase);
        const r = h.r * wobble;
        const g = ctx.createRadialGradient(center, center, baseRadius * 0.4, center, center, r);
        g.addColorStop(0, `rgba(${outerHue} / ${h.a})`);
        g.addColorStop(0.6, `rgba(${outerHue} / ${h.a * 0.35})`);
        g.addColorStop(1, `rgba(${outerHue} / 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(center, center, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Core — bright nucleus with subtle scale on amplitude.
      const coreR = baseRadius * (0.95 + amp * 0.35);
      const coreGrad = ctx.createRadialGradient(
        center - coreR * 0.15,
        center - coreR * 0.2,
        0,
        center,
        center,
        coreR,
      );
      coreGrad.addColorStop(0, `rgba(${inner} / 0.95)`);
      coreGrad.addColorStop(0.45, `rgba(${outerHue} / 0.85)`);
      coreGrad.addColorStop(1, `rgba(${outerHue} / 0)`);
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(center, center, coreR, 0, Math.PI * 2);
      ctx.fill();

      // Specular highlight — top-left inner shimmer for the "glass marble"
      // look. Pulse the offset slowly so it never feels frozen.
      const hiR = coreR * 0.55;
      const hiX = center - coreR * (0.25 + 0.04 * Math.sin(t * 0.7));
      const hiY = center - coreR * (0.32 + 0.04 * Math.cos(t * 0.7));
      const hiGrad = ctx.createRadialGradient(hiX, hiY, 0, hiX, hiY, hiR);
      hiGrad.addColorStop(0, 'rgba(255 255 255 / 0.55)');
      hiGrad.addColorStop(1, 'rgba(255 255 255 / 0)');
      ctx.fillStyle = hiGrad;
      ctx.beginPath();
      ctx.arc(hiX, hiY, hiR, 0, Math.PI * 2);
      ctx.fill();

      // Thinking ring — a thin rotating arc whose head is bright and tail
      // fades. Skipped on other states to keep visual semantics distinct.
      if (s === 'thinking') {
        const ringR = baseRadius * 1.05;
        const headAngle = (t * 1.4) % (Math.PI * 2);
        const arcLen = Math.PI * 1.2;
        for (let i = 0; i < 60; i++) {
          const f = i / 60;
          const a = headAngle - f * arcLen;
          const x = center + Math.cos(a) * ringR;
          const y = center + Math.sin(a) * ringR;
          ctx.fillStyle = `rgba(${outerHue} / ${(1 - f) * 0.6})`;
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
