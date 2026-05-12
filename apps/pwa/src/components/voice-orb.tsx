'use client';

import { useEffect, useRef } from 'react';

// VoiceOrb — oscilloscope-style waveform visualizer. Reads as a service
// instrument rather than the generic AI-assistant orb. Pure 2D canvas,
// no SVG / WebGL, so it stays smooth on mid-tier mobile.
//
// Composition:
//   • Circular scope frame — a thin brand-tinted ring; the "bezel".
//   • Centered waveform — a horizontal time-domain line. When an
//     AnalyserNode is supplied (listening state), it draws the live
//     mic data. Otherwise it renders a procedural wave whose amplitude
//     and frequency are state-dependent.
//   • Crosshair horizon — faint center line + vertical playhead, like
//     a real oscilloscope display.
//   • Center pulse dot — small bright marker that grows with amplitude.
//
// State signals via hue + waveform character:
//   idle       — soft brand glow, very low amplitude line (heartbeat)
//   listening  — cyan, live waveform from mic analyser
//   thinking   — violet, rolling sine wave + scanning sweep
//   speaking   — warm brand color, layered procedural wave

export type VoiceOrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: VoiceOrbState;
  analyser?: AnalyserNode | null;
  size?: number;
  className?: string;
}

export function VoiceOrb({ state, analyser, size = 280, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Smoothed amplitude — keeps the scope from jittering each frame.
  const ampRef = useRef(0);
  const stateRef = useRef<VoiceOrbState>(state);
  const analyserRef = useRef<AnalyserNode | null>(analyser ?? null);

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
    const scopeR = size * 0.42; // outer scope ring radius
    const traceR = size * 0.34; // half-width of the visible waveform
    const traceH = size * 0.18; // peak-to-peak height of the wave

    const cssVar = (name: string, fallback: string) => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return v || fallback;
    };
    const brand = cssVar('--brand', '247 117 49');

    // Reusable buffer for the analyser samples.
    const fft = new Uint8Array(1024);
    // Sample buffer for the rendered waveform (256 points spread across
    // the trace width — enough resolution to look like a real scope).
    const SAMPLES = 256;
    const waveform = new Float32Array(SAMPLES);

    let raf = 0;
    const t0 = performance.now();

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

    // Fill the waveform buffer from the analyser's time-domain data.
    // Decimates the analyser's larger buffer down to SAMPLES points.
    const fillFromAnalyser = (): boolean => {
      const an = analyserRef.current;
      if (!an) return false;
      try {
        const N = Math.min(fft.length, an.frequencyBinCount);
        an.getByteTimeDomainData(fft);
        const step = Math.max(1, Math.floor(N / SAMPLES));
        for (let i = 0; i < SAMPLES; i++) {
          const idx = Math.min(N - 1, i * step);
          waveform[i] = (fft[idx]! - 128) / 128;
        }
        return true;
      } catch {
        return false;
      }
    };

    // Procedural waveform — used when no analyser is wired or it returns
    // silence. Each state has its own character.
    const fillProcedural = (t: number, s: VoiceOrbState, amp: number) => {
      for (let i = 0; i < SAMPLES; i++) {
        const x = i / SAMPLES; // 0..1
        let v = 0;
        if (s === 'thinking') {
          // Rolling sine + traveling sweep window.
          v =
            0.5 * Math.sin((x + t * 0.6) * Math.PI * 4) +
            0.25 * Math.sin((x + t * 1.3) * Math.PI * 9);
          // Envelope so the wave doesn't reach the edges.
          v *= Math.sin(x * Math.PI);
        } else if (s === 'speaking') {
          // Layered higher-frequency wave that mimics speech cadence.
          v =
            0.55 * Math.sin((x + t * 1.4) * Math.PI * 6) +
            0.30 * Math.sin((x + t * 2.1) * Math.PI * 11) +
            0.15 * Math.sin((x + t * 0.9) * Math.PI * 19);
          v *= Math.sin(x * Math.PI);
          v *= 0.6 + amp * 1.4;
        } else if (s === 'listening') {
          // Fallback when analyser hasn't returned a usable signal yet —
          // gentle "armed" wave.
          v = 0.25 * Math.sin((x + t * 0.8) * Math.PI * 3) * Math.sin(x * Math.PI);
        } else {
          // idle: slow heartbeat
          v = 0.18 * Math.sin((x + t * 0.4) * Math.PI * 2) * Math.sin(x * Math.PI);
        }
        waveform[i] = v;
      }
    };

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const s = stateRef.current;

      // Hue selection per state.
      let hue = brand;
      switch (s) {
        case 'idle':
          hue = brand;
          break;
        case 'listening':
          hue = '60 170 255';
          break;
        case 'thinking':
          hue = '140 90 255';
          break;
        case 'speaking':
          hue = brand;
          break;
      }

      // Amplitude — analyser when available, else a deterministic wave
      // that gives idle/thinking life without microphone input.
      const measured = sampleAmplitude();
      const hasAnalyser = analyserRef.current !== null;
      let target: number;
      if (s === 'listening' && hasAnalyser) {
        target = Math.min(1, measured * 4);
      } else if (s === 'speaking') {
        // No analyser tap on HTMLAudio playback — procedural pulse.
        target =
          0.32 +
          0.22 * Math.abs(Math.sin(t * 5.2)) +
          0.14 * Math.abs(Math.sin(t * 7.1 + 0.7));
      } else if (s === 'listening') {
        target = 0.2 + 0.08 * Math.sin(t * 1.5);
      } else if (s === 'thinking') {
        target = 0.25 + 0.08 * Math.sin(t * 1.6);
      } else {
        target = 0.13 + 0.06 * Math.sin(t * 0.85);
      }
      const k = target > ampRef.current ? 0.35 : 0.08;
      ampRef.current = ampRef.current + (target - ampRef.current) * k;
      const amp = ampRef.current;

      ctx.clearRect(0, 0, size, size);

      // --- Soft glow halo (subtle backdrop, sets the hue) -------------
      // Outer radius is kept inside the canvas bounds so the radial
      // gradient never clips against the canvas square — otherwise the
      // alpha-non-zero region forms a visible "rounded box" outline
      // because the corners (beyond the gradient) read as fully
      // transparent while the edges (just inside the gradient) don't.
      const haloOuter = scopeR * 1.18;
      const halo = ctx.createRadialGradient(
        center,
        center,
        scopeR * 0.5,
        center,
        center,
        haloOuter,
      );
      halo.addColorStop(0, `rgba(${hue} / 0.18)`);
      halo.addColorStop(0.55, `rgba(${hue} / 0.06)`);
      halo.addColorStop(1, `rgba(${hue} / 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(center, center, haloOuter, 0, Math.PI * 2);
      ctx.fill();

      // --- Scope bezel rings ------------------------------------------
      // Outer ring
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = `rgba(${hue} / 0.55)`;
      ctx.beginPath();
      ctx.arc(center, center, scopeR, 0, Math.PI * 2);
      ctx.stroke();
      // Inner ring (slightly fainter, looks like a recessed bezel)
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = `rgba(${hue} / 0.28)`;
      ctx.beginPath();
      ctx.arc(center, center, scopeR * 0.92, 0, Math.PI * 2);
      ctx.stroke();

      // --- Background tick marks (oscilloscope grid feel) -------------
      ctx.strokeStyle = `rgba(${hue} / 0.18)`;
      ctx.lineWidth = 0.5;
      // Horizon line (center)
      ctx.beginPath();
      ctx.moveTo(center - traceR, center);
      ctx.lineTo(center + traceR, center);
      ctx.stroke();
      // Vertical tick marks at 25% / 50% / 75%
      for (const f of [0.25, 0.5, 0.75]) {
        const x = center - traceR + traceR * 2 * f;
        ctx.beginPath();
        ctx.moveTo(x, center - 4);
        ctx.lineTo(x, center + 4);
        ctx.stroke();
      }

      // --- The waveform itself ----------------------------------------
      // For listening: use live mic data when available; otherwise
      // procedural so we never show a dead-flat scope (looks broken).
      let usedAnalyser = false;
      if (s === 'listening' && hasAnalyser) {
        usedAnalyser = fillFromAnalyser();
      }
      if (!usedAnalyser) {
        fillProcedural(t, s, amp);
      }

      // Scale: live mic data is already -1..1; amplify a bit so quiet
      // speech still draws visible peaks.
      const scale = s === 'listening' && usedAnalyser ? 1.8 : 1.0;
      const heightScale = traceH * 0.5 * (0.6 + amp * 1.2);

      // Drop shadow / outer glow on the trace.
      ctx.strokeStyle = `rgba(${hue} / 0.35)`;
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < SAMPLES; i++) {
        const x = center - traceR + (i / (SAMPLES - 1)) * traceR * 2;
        const y = center + waveform[i]! * heightScale * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Sharp trace line on top.
      ctx.strokeStyle = `rgba(${hue} / 0.95)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < SAMPLES; i++) {
        const x = center - traceR + (i / (SAMPLES - 1)) * traceR * 2;
        const y = center + waveform[i]! * heightScale * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // --- Center playhead dot ----------------------------------------
      const dotR = 2.5 + amp * 3;
      const dotGrad = ctx.createRadialGradient(center, center, 0, center, center, dotR * 4);
      dotGrad.addColorStop(0, `rgba(${hue} / 0.95)`);
      dotGrad.addColorStop(0.4, `rgba(${hue} / 0.4)`);
      dotGrad.addColorStop(1, `rgba(${hue} / 0)`);
      ctx.fillStyle = dotGrad;
      ctx.beginPath();
      ctx.arc(center, center, dotR * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255 255 255 / 0.95)`;
      ctx.beginPath();
      ctx.arc(center, center, dotR, 0, Math.PI * 2);
      ctx.fill();

      // --- Thinking sweep --------------------------------------------
      // Same semantic as before — a rotating arc says "waiting on the
      // model." Drawn as a faint sweep along the outer scope ring.
      if (s === 'thinking') {
        const headAngle = (t * 1.6) % (Math.PI * 2);
        const arcLen = Math.PI * 0.9;
        for (let i = 0; i < 48; i++) {
          const f = i / 48;
          const a = headAngle - f * arcLen;
          const x = center + Math.cos(a) * scopeR;
          const y = center + Math.sin(a) * scopeR;
          ctx.fillStyle = `rgba(${hue} / ${(1 - f) * 0.85})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.3 + (1 - f) * 1.3, 0, Math.PI * 2);
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
      style={{ willChange: 'transform' }}
      aria-hidden
    />
  );
}
