'use client';

import { useRef, useState } from 'react';

// /sound-test — tap a button, hear the intro WAV. This bypasses every
// autoplay restriction (the play() call is in direct response to a
// user gesture), so if you tap and still hear nothing, the cause is
// device/volume/codec, not browser policy. Temporary diagnostic.

export default function SoundTestPage() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'ended' | 'error'>(
    'idle',
  );
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [duration, setDuration] = useState<number | null>(null);

  async function playTestSound() {
    setStatus('loading');
    setErrorMessage('');
    setDuration(null);
    try {
      const audio = new Audio('/intro-sound.wav');
      audio.preload = 'auto';
      audio.volume = 1.0;
      audioRef.current = audio;
      audio.addEventListener('loadedmetadata', () => {
        setDuration(audio.duration);
      });
      audio.addEventListener('ended', () => {
        setStatus('ended');
      });
      audio.addEventListener('error', () => {
        setStatus('error');
        setErrorMessage(`MediaError code ${audio.error?.code ?? '?'}: ${audio.error?.message ?? 'unknown'}`);
      });
      await audio.play();
      setStatus('playing');
    } catch (e) {
      setStatus('error');
      setErrorMessage(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  function stopTestSound() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setStatus('idle');
  }

  return (
    <main
      style={{
        padding: 24,
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        fontSize: 14,
        lineHeight: 1.6,
        background: '#0E1217',
        color: '#F5F6F8',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 16, fontWeight: 700 }}>Intro sound test</h1>
      <p style={{ marginBottom: 18, opacity: 0.8 }}>
        Tap the button below. The intro WAV will play with full volume in direct response
        to your tap — no autoplay restrictions apply.
      </p>

      <button
        type="button"
        onClick={status === 'playing' ? stopTestSound : playTestSound}
        style={{
          padding: '18px 26px',
          background: status === 'playing' ? '#B02B3D' : '#256CD3',
          color: 'white',
          border: 0,
          borderRadius: 10,
          fontSize: 16,
          fontWeight: 700,
          width: '100%',
        }}
      >
        {status === 'playing' ? '⏹ Stop' : status === 'loading' ? 'Loading…' : '▶ Play intro sound'}
      </button>

      <div style={{ marginTop: 22, padding: 14, background: '#1D58B2', borderRadius: 8 }}>
        <div>
          <strong>Status:</strong> {status}
        </div>
        {duration !== null && (
          <div>
            <strong>WAV duration:</strong> {duration.toFixed(2)}s
          </div>
        )}
        {errorMessage && (
          <div style={{ marginTop: 8, color: '#FFB3B3' }}>
            <strong>Error:</strong> {errorMessage}
          </div>
        )}
      </div>

      <hr style={{ borderColor: '#4A5560', margin: '22px 0' }} />

      <h2 style={{ fontSize: 16, marginBottom: 8, fontWeight: 600 }}>If you don't hear it</h2>
      <ul style={{ paddingLeft: 20, opacity: 0.9 }}>
        <li style={{ marginBottom: 8 }}>
          Check phone <strong>media volume</strong> (not ringer): turn it up using the
          volume buttons while a sound is playing, then tap the speaker icon to switch
          to Media.
        </li>
        <li style={{ marginBottom: 8 }}>
          Check <strong>Do Not Disturb</strong>: some Android setups mute all media in
          DND mode.
        </li>
        <li style={{ marginBottom: 8 }}>
          Check <strong>Bluetooth</strong>: if a headset is paired but out of range,
          Android can still route audio to it silently.
        </li>
        <li style={{ marginBottom: 8 }}>
          Status above will show "playing" while the WAV is decoded and being output —
          if it says "playing" but you hear nothing, it's a device-side audio routing
          or volume issue, not the code.
        </li>
      </ul>
    </main>
  );
}
