'use client';

import { useEffect, useState } from 'react';

// /diag — on-device diagnostic for the SplashIntro state.
// Surfaces every input the splash component uses to decide whether to
// animate, so we can see from the phone screen (no USB debugging
// required) why the splash skipped on a given device.
//
// Temporary — remove once the Android animation issue is resolved.

const SPLASH_PLAYS_KEY = 'fs:splash:plays';
const SPLASH_VIEW_THRESHOLD = 3;

export default function DiagPage() {
  const [state, setState] = useState<{
    plays: number | null;
    threshold: number;
    reducedMotion: boolean | null;
    localStorageWorks: boolean | null;
    matchMediaSupported: boolean | null;
    userAgent: string;
    standalone: boolean | null;
    cleared: boolean;
  }>({
    plays: null,
    threshold: SPLASH_VIEW_THRESHOLD,
    reducedMotion: null,
    localStorageWorks: null,
    matchMediaSupported: null,
    userAgent: '',
    standalone: null,
    cleared: false,
  });

  function read() {
    let plays: number | null = null;
    let localStorageWorks = false;
    try {
      const raw = window.localStorage.getItem(SPLASH_PLAYS_KEY);
      plays = raw ? parseInt(raw, 10) : 0;
      localStorageWorks = true;
    } catch {
      localStorageWorks = false;
    }
    const matchMediaSupported = typeof window.matchMedia === 'function';
    const reducedMotion = matchMediaSupported
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : null;
    const standalone = matchMediaSupported
      ? window.matchMedia('(display-mode: standalone)').matches
      : null;
    setState((s) => ({
      ...s,
      plays,
      reducedMotion,
      localStorageWorks,
      matchMediaSupported,
      userAgent: navigator.userAgent,
      standalone,
    }));
  }

  useEffect(() => {
    read();
  }, []);

  function clearPlays() {
    try {
      window.localStorage.removeItem(SPLASH_PLAYS_KEY);
    } catch {
      /* ignore */
    }
    setState((s) => ({ ...s, cleared: true }));
    read();
  }

  return (
    <main
      style={{
        padding: 20,
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        fontSize: 13,
        lineHeight: 1.6,
        background: '#0E1217',
        color: '#F5F6F8',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 14, fontWeight: 700 }}>
        SplashIntro diagnostics
      </h1>
      <Row label="fs:splash:plays" value={state.plays} />
      <Row label="threshold" value={state.threshold} />
      <Row
        label="under threshold?"
        value={state.plays !== null ? String(state.plays < state.threshold) : '—'}
        good={state.plays !== null && state.plays < state.threshold}
      />
      <Row
        label="prefers-reduced-motion"
        value={state.reducedMotion === null ? '—' : String(state.reducedMotion)}
        good={state.reducedMotion === false}
        bad={state.reducedMotion === true}
      />
      <Row label="localStorage works" value={String(state.localStorageWorks)} />
      <Row label="matchMedia supported" value={String(state.matchMediaSupported)} />
      <Row label="display-mode: standalone" value={String(state.standalone)} />
      <hr style={{ borderColor: '#4A5560', margin: '14px 0' }} />
      <div style={{ fontSize: 11, opacity: 0.7, wordBreak: 'break-all' }}>
        <strong>UA:</strong> {state.userAgent}
      </div>

      <hr style={{ borderColor: '#4A5560', margin: '14px 0' }} />
      <h2 style={{ fontSize: 14, marginBottom: 8, fontWeight: 600 }}>Verdict</h2>
      <div style={{ padding: 10, background: '#1D58B2', borderRadius: 6 }}>
        {state.plays === null
          ? 'Loading…'
          : state.reducedMotion === true
            ? 'Splash will SKIP — prefers-reduced-motion is on. Turn off Battery Saver / Accessibility → Remove animations / Developer options → Animation scale.'
            : state.plays >= state.threshold
              ? `Splash will SKIP — play count (${state.plays}) ≥ threshold (${state.threshold}). Tap Clear below.`
              : 'Splash should ANIMATE. If it does not, the issue is in CSS rendering or the React mount itself.'}
      </div>

      <button
        type="button"
        onClick={clearPlays}
        style={{
          marginTop: 16,
          padding: '12px 18px',
          background: '#B02B3D',
          color: 'white',
          border: 0,
          borderRadius: 8,
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        Clear fs:splash:plays{state.cleared ? ' ✓' : ''}
      </button>

      <div style={{ marginTop: 18, fontSize: 12, opacity: 0.7 }}>
        After clearing, rescan the QR — splash should play.
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string | number | null;
  good?: boolean;
  bad?: boolean;
}) {
  const color = good ? '#3DDC84' : bad ? '#FF5252' : '#F5F6F8';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value ?? '—'}</span>
    </div>
  );
}
