'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { VoiceOrb, type VoiceOrbState } from './voice-orb';
import { VirtualJobAid } from './virtual-job-aid';
import {
  fetchPreflight,
  speak,
  streamChat,
  transcribeAudio,
  type PreflightBrief,
} from '@/lib/api';

const PROCEDURE_DIRECTIVE_RE =
  /\[procedure:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

// Full-screen voice experience. Opens automatically on QR scan (once per
// session), and any time the user taps the mic button in the chat composer.
//
// Lifecycle:
//   1. mount → idle (waiting for a user gesture to unlock audio)
//   2. user taps "Begin" or anywhere on the orb → AudioContext.resume()
//   3. preflight fetches in parallel → greeting plays (state=speaking)
//   4. greeting finishes → state=listening, mic opens, VAD listens for speech
//   5. user speaks → MediaRecorder records; on ≥1500 ms of silence it stops
//   6. STT transcribe → state=thinking → /ai/chat stream collects full text
//   7. TTS speaks the response (state=speaking) → loop back to step 4
//
// Tap orb mid-speak: interrupts TTS and goes straight to listening.
// Tap orb mid-listen: ends the utterance early.
// X or swipe-down: dismisses; conversationId is returned to the parent so
//   the existing ChatTab thread continues seamlessly.

interface Props {
  assetInstanceId: string;
  partId?: string;
  /** Existing conversation to continue, if any. Lets the chat tab and voice
   *  mode share a single thread. */
  initialConversationId?: string;
  devUserId: string;
  devOrgId: string;
  onClose: (state: { conversationId?: string; turns: VoiceTurn[] }) => void;
}

export interface VoiceTurn {
  role: 'user' | 'assistant';
  text: string;
}

const SILENCE_RMS = 0.02; // below this = "quiet"
const SILENCE_HOLD_MS = 1500; // how long quiet must persist before we stop
const MIN_UTTERANCE_MS = 350; // ignore micro-clicks shorter than this

export function VoiceMode(props: Props): React.ReactElement {
  const [orbState, setOrbState] = useState<VoiceOrbState>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [statusLine, setStatusLine] = useState<string>('Tap to begin');
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [needsGesture, setNeedsGesture] = useState(true);
  const [preflight, setPreflight] = useState<PreflightBrief | null>(null);
  // When the AI emits a [procedure:UUID] directive, we suspend the voice
  // greeter and mount VirtualJobAid in its place — same overlay, hands-
  // free walkthrough. Clearing the source resumes voice mode and goes
  // back to listening.
  const [jobAidSource, setJobAidSource] = useState<{ docId: string } | null>(null);
  const conversationIdRef = useRef<string | undefined>(props.initialConversationId);

  // Audio infra. Allocated lazily on first user gesture so iOS doesn't
  // mark the AudioContext as auto-started (which would silence everything).
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Silent looping <audio> primer. iOS routes Web Audio output to the
  // ringer/silent volume bus unless an HTMLMediaElement is already playing
  // when the AudioContext is created — without this, the volume rocker
  // controls ringer volume (not media) and TTS is silent in vibrate mode.
  const silentPrimerRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recorderStartRef = useRef<number>(0);
  const silenceCheckRef = useRef<number | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const lastActiveAnalyserRef = useRef<AnalyserNode | null>(null);
  // Live ref into the analyser feeding the orb so the canvas reacts to the
  // currently-active audio path (mic during listening, TTS during speaking).
  const [activeAnalyser, setActiveAnalyser] = useState<AnalyserNode | null>(null);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function teardown() {
    chatAbortRef.current?.abort();
    if (silenceCheckRef.current) {
      cancelAnimationFrame(silenceCheckRef.current);
      silenceCheckRef.current = null;
    }
    if (ttsSourceRef.current) {
      try {
        ttsSourceRef.current.stop();
      } catch {
        // already stopped
      }
      ttsSourceRef.current.disconnect();
      ttsSourceRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // already stopped
      }
    }
    recorderRef.current = null;
    if (micStreamRef.current) {
      for (const tr of micStreamRef.current.getTracks()) tr.stop();
      micStreamRef.current = null;
    }
    micAnalyserRef.current?.disconnect();
    ttsAnalyserRef.current?.disconnect();
    micAnalyserRef.current = null;
    ttsAnalyserRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    if (silentPrimerRef.current) {
      try {
        silentPrimerRef.current.pause();
      } catch {
        // ignore
      }
      const url = silentPrimerRef.current.src;
      silentPrimerRef.current.src = '';
      silentPrimerRef.current = null;
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
  }

  // Build a tiny (100 ms) silent WAV as a blob URL. Used as the priming
  // track that switches iOS into the media-playback audio session — see
  // silentPrimerRef for the full reason.
  function makeSilentAudioUrl(): string {
    const sampleRate = 8000;
    const numSamples = 800;
    const bytes = new Uint8Array(44 + numSamples);
    const view = new DataView(bytes.buffer);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    view.setUint32(4, 36 + numSamples, true);
    bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
    bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    bytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
    view.setUint32(40, numSamples, true);
    for (let i = 0; i < numSamples; i++) bytes[44 + i] = 0x80; // 0x80 = silence (8-bit unsigned)
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }

  // ---------- audio bootstrap ----------

  async function unlock() {
    if (!needsGesture) return;
    setNeedsGesture(false);
    setStatusLine('Listening for your voice…');

    // Fetch preflight in parallel with audio setup — both round-trips race.
    const briefPromise = fetchPreflight(props.assetInstanceId).catch((e) => {
      // Preflight failure shouldn't block voice mode; we just skip the brief.
      console.warn('[voice] preflight failed', e);
      return null;
    });

    // Prime the iOS audio session with a silent looping <audio> element
    // BEFORE creating the AudioContext. Without this, Web Audio output
    // routes to the ringer/silent volume bus — meaning the side volume
    // buttons adjust the ringer (not media), and TTS is muted entirely
    // when the phone's silent switch is on. Best-effort; failures here
    // don't block voice mode on platforms that don't have this quirk.
    try {
      const primer = new Audio();
      primer.src = makeSilentAudioUrl();
      primer.loop = true;
      primer.setAttribute('playsinline', 'true');
      primer.preload = 'auto';
      silentPrimerRef.current = primer;
      await primer.play();
    } catch (err) {
      console.warn('[voice] silent priming failed; volume bus may be wrong on iOS', err);
    }

    try {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.4;
      src.connect(an);
      micAnalyserRef.current = an;

      // TTS analyser — separate node so we can swap the orb feed cleanly.
      const tts = ctx.createAnalyser();
      tts.fftSize = 1024;
      tts.smoothingTimeConstant = 0.4;
      ttsAnalyserRef.current = tts;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Couldn't access the microphone: ${err.message}`
          : 'Microphone access was denied.',
      );
      setOrbState('idle');
      setNeedsGesture(true);
      return;
    }

    const brief = await briefPromise;
    setPreflight(brief);

    if (brief?.greeting) {
      await speakText(brief.greeting);
    }
    void startListening();
  }

  // ---------- TTS playback ----------

  async function speakText(text: string) {
    const ctx = audioCtxRef.current;
    const tts = ttsAnalyserRef.current;
    if (!ctx || !tts) return;
    setOrbState('speaking');
    setStatusLine('Speaking');
    setActiveAnalyser(tts);
    lastActiveAnalyserRef.current = tts;
    try {
      const resp = await speak(text);
      const buf = await resp.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(tts);
      tts.connect(ctx.destination);
      ttsSourceRef.current = source;
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
    } catch (err) {
      console.warn('[voice] TTS failed', err);
    } finally {
      ttsSourceRef.current = null;
    }
  }

  function interruptTTS() {
    if (ttsSourceRef.current) {
      try {
        ttsSourceRef.current.stop();
      } catch {
        // already done
      }
      ttsSourceRef.current = null;
    }
  }

  // ---------- listening / VAD ----------

  async function startListening() {
    const stream = micStreamRef.current;
    const an = micAnalyserRef.current;
    if (!stream || !an) return;

    setOrbState('listening');
    setStatusLine('Listening');
    setTranscript('');
    setActiveAnalyser(an);
    lastActiveAnalyserRef.current = an;

    let mime: string | undefined;
    if (typeof MediaRecorder !== 'undefined') {
      // Safari prefers mp4/aac, Chrome prefers webm/opus. Let the browser
      // pick; if neither is supported, MediaRecorder constructor will throw
      // and we fall back to push-to-talk only.
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    }

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      setError('Recording is not supported on this device.');
      setOrbState('idle');
      return;
    }
    recorderRef.current = rec;
    recorderChunksRef.current = [];
    recorderStartRef.current = performance.now();

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recorderChunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      void onRecordingStopped(mime ?? 'audio/webm');
    };
    rec.start(250); // emit chunks every 250 ms so onstop has data even if the
    // recorder dies on tab-switch — small cost, large reliability win.

    // Silence detector — runs on rAF, samples mic RMS, calls stop() once
    // we've seen SILENCE_HOLD_MS continuous quiet AFTER first speech.
    let sawSpeech = false;
    let quietSince: number | null = null;
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!recorderRef.current) return;
      try {
        an.getByteTimeDomainData(buf);
      } catch {
        return;
      }
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const elapsed = now - recorderStartRef.current;

      if (!sawSpeech && rms > SILENCE_RMS * 1.2 && elapsed > MIN_UTTERANCE_MS) {
        sawSpeech = true;
      }
      if (sawSpeech) {
        if (rms < SILENCE_RMS) {
          if (quietSince === null) quietSince = now;
          if (now - quietSince >= SILENCE_HOLD_MS) {
            stopRecording();
            return;
          }
        } else {
          quietSince = null;
        }
      }
      silenceCheckRef.current = requestAnimationFrame(tick);
    };
    silenceCheckRef.current = requestAnimationFrame(tick);
  }

  function stopRecording() {
    if (silenceCheckRef.current) {
      cancelAnimationFrame(silenceCheckRef.current);
      silenceCheckRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    }
  }

  async function onRecordingStopped(mime: string) {
    const chunks = recorderChunksRef.current;
    recorderChunksRef.current = [];
    recorderRef.current = null;
    if (chunks.length === 0) {
      // Silent recording — just keep listening.
      void startListening();
      return;
    }
    const elapsed = performance.now() - recorderStartRef.current;
    if (elapsed < MIN_UTTERANCE_MS) {
      void startListening();
      return;
    }
    const blob = new Blob(chunks, { type: mime });

    setOrbState('thinking');
    setStatusLine('Transcribing');
    setActiveAnalyser(null);

    let userText = '';
    try {
      userText = await transcribeAudio(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed.');
      void startListening();
      return;
    }
    if (!userText) {
      void startListening();
      return;
    }

    setTurns((t) => [...t, { role: 'user', text: userText }]);
    setTranscript(userText);

    // Now run the actual chat turn.
    setStatusLine('Thinking');
    setOrbState('thinking');

    let assistantText = '';
    const abort = new AbortController();
    chatAbortRef.current = abort;
    try {
      await streamChat(
        {
          assetInstanceId: props.assetInstanceId,
          conversationId: conversationIdRef.current,
          message: userText,
          devUserId: props.devUserId,
          devOrgId: props.devOrgId,
          ...(props.partId ? { partId: props.partId } : {}),
        },
        (event) => {
          if (event.type === 'conversation') {
            conversationIdRef.current = event.conversationId;
          } else if (event.type === 'delta') {
            assistantText += event.text;
            // Optional: stream the live transcript too (without [cite:] markers).
            setTranscript(assistantText.replace(/\[cite:[a-f0-9-]{8,}\]/gi, ''));
          }
        },
        abort.signal,
      );
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Assistant failed.');
      }
      void startListening();
      return;
    }
    chatAbortRef.current = null;

    const cleaned = assistantText.replace(/\[cite:[a-f0-9-]{8,}\]/gi, '').trim();

    // Procedure handoff — the AI signaled an authored procedure walkthrough
    // is the right answer. Skip TTS-of-the-directive and mount VirtualJobAid
    // in place; the runner has its own per-step audio (authored or TTS).
    const procMatch = PROCEDURE_DIRECTIVE_RE.exec(cleaned);
    if (procMatch && procMatch[1]) {
      stopRecording();
      micAnalyserRef.current?.disconnect();
      setOrbState('idle');
      setStatusLine('Walking you through the procedure');
      setJobAidSource({ docId: procMatch[1] });
      setTurns((t) => [
        ...t,
        { role: 'assistant', text: `Opened procedure walkthrough.` },
      ]);
      return;
    }

    if (cleaned) {
      setTurns((t) => [...t, { role: 'assistant', text: cleaned }]);
      setTranscript(cleaned);
      await speakText(cleaned);
    }
    // Loop: after speaking, automatically listen again.
    void startListening();
  }

  // ---------- orb tap handler ----------

  const onOrbTap = useCallback(() => {
    // Soft haptic on every orb tap. Best-effort — desktop browsers ignore.
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        // some browsers throw on insecure contexts; ignore
      }
    }
    if (needsGesture) {
      void unlock();
      return;
    }
    if (orbState === 'speaking') {
      interruptTTS();
      void startListening();
      return;
    }
    if (orbState === 'listening') {
      stopRecording();
      return;
    }
    if (orbState === 'thinking') {
      // Cancel the in-flight chat turn — let the user redirect.
      chatAbortRef.current?.abort();
      void startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsGesture, orbState]);

  function close() {
    teardown();
    props.onClose({
      conversationId: conversationIdRef.current,
      turns,
    });
  }

  // Swipe-down to dismiss — small gesture, reads the touch start/end deltas.
  const swipeStart = useRef<number | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    swipeStart.current = e.touches[0]?.clientY ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start === null) return;
    const end = e.changedTouches[0]?.clientY ?? start;
    if (end - start > 120) close();
  }

  // While a procedure walkthrough is active, that runner takes over the
  // whole overlay. Closing it returns control to voice mode (back to
  // listening so the tech can ask another question hands-free).
  if (jobAidSource) {
    return (
      <VirtualJobAid
        source={{
          kind: 'doc',
          docId: jobAidSource.docId,
          devUserId: props.devUserId,
          devOrgId: props.devOrgId,
        }}
        onClose={() => {
          setJobAidSource(null);
          // Re-attach mic to the analyser so audio reactivity resumes,
          // then drop back into the listen loop.
          const ctx = audioCtxRef.current;
          const stream = micStreamRef.current;
          const an = micAnalyserRef.current;
          if (ctx && stream && an) {
            try {
              const src = ctx.createMediaStreamSource(stream);
              src.connect(an);
            } catch {
              // already connected — fine
            }
          }
          void startListening();
        }}
      />
    );
  }

  return (
    <div
      className="voice-mode-root"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-label="Voice assistant"
    >
      <button
        type="button"
        className="voice-mode-close"
        onClick={close}
        aria-label="Close voice mode"
      >
        <X size={20} strokeWidth={2.25} />
      </button>

      <div className="voice-mode-asset">
        {preflight ? (
          <>
            <span className="voice-mode-asset-name">{preflight.assetModelDisplayName}</span>
            <span className="voice-mode-asset-sep">·</span>
            <span className="voice-mode-asset-serial">S/N {preflight.serialNumber}</span>
          </>
        ) : (
          <span className="voice-mode-asset-name">Connecting…</span>
        )}
      </div>

      <button
        type="button"
        className="voice-mode-orb-button"
        onClick={onOrbTap}
        aria-label={
          needsGesture
            ? 'Tap to begin'
            : orbState === 'listening'
              ? 'Stop listening'
              : orbState === 'speaking'
                ? 'Interrupt'
                : 'Voice'
        }
      >
        <VoiceOrb state={orbState} analyser={activeAnalyser} size={280} />
      </button>

      <div
        className="voice-mode-status"
        aria-live="polite"
        data-state={orbState}
      >
        <span className="voice-mode-status-led" />
        <span>{error ?? statusLine}</span>
      </div>

      {/* Transcript appears only between turns (after the user speaks,
          before the AI starts speaking back). During 'speaking' the audio
          IS the channel — showing a wall of text behind the orb just
          collides visually. While 'listening' we show the user's previous
          utterance so they have feedback their words were heard. */}
      {transcript && orbState !== 'speaking' && orbState !== 'thinking' && (
        <p className="voice-mode-transcript" aria-live="polite">
          {transcript}
        </p>
      )}

      <div className="voice-mode-footer">
        <button
          type="button"
          className="voice-mode-keyboard"
          onClick={close}
          aria-label="Switch to keyboard"
        >
          <Keyboard size={16} strokeWidth={2} />
          <span>Keyboard</span>
        </button>
      </div>
    </div>
  );
}
