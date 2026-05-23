'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  FileText,
  Loader2,
  Mic,
  Search,
  ShieldAlert,
  X,
  Volume2,
} from 'lucide-react';
import {
  speak,
  voiceSearch,
  type VoiceSearchResponse,
  type VoiceSearchResult,
} from '@/lib/api';

// VoiceSearch — full-screen overlay that records a short query, runs the
// hybrid search against the current asset's content pack version (plus
// overlays), speaks a TTS preview, and renders a ranked list. Tapping any
// result returns its jumpTarget to the parent which decides how to mount
// the destination (VirtualJobAid for procedure_step, doc viewer for
// doc_chunk, etc.).
//
// Lifecycle:
//   idle → recording → transcribing → ready (results visible)
//        → error states surfaced inline; the overlay stays open so the
//          user can re-record without re-mounting.

const SILENCE_RMS = 0.02;
const SILENCE_HOLD_MS = 1500;
const MIN_UTTERANCE_MS = 350;

type Phase = 'idle' | 'recording' | 'processing' | 'ready' | 'error';

interface Props {
  assetInstanceId: string;
  onClose: () => void;
  /** Called when the user taps a result. The parent navigates per the
   *  jumpTarget (mount VirtualJobAid, open SectionViewer, etc.). */
  onJump: (result: VoiceSearchResult) => void;
}

export function VoiceSearch({ assetInstanceId, onClose, onJump }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<VoiceSearchResponse | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const silenceTimerRef = useRef<number | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function teardown() {
    if (silenceTimerRef.current != null) {
      cancelAnimationFrame(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.src = '';
      ttsAudioRef.current = null;
    }
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
  }

  async function startRecording() {
    setError(null);
    setResponse(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new Ctx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;

      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const mime = candidates.find(
        (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
      );
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];
      startedAtRef.current = performance.now();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: mime ?? 'audio/webm',
        });
        chunksRef.current = [];
        void onRecordingStopped(blob);
      };
      rec.start(250);
      setPhase('recording');

      // VAD loop — auto-stop after a window of silence post-speech.
      let sawSpeech = false;
      let quietSince: number | null = null;
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!recorderRef.current) return;
        try {
          analyser.getByteTimeDomainData(buf);
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
        const elapsed = now - startedAtRef.current;
        if (!sawSpeech && rms > SILENCE_RMS * 1.2 && elapsed > MIN_UTTERANCE_MS) {
          sawSpeech = true;
        }
        if (sawSpeech) {
          if (rms < SILENCE_RMS) {
            if (quietSince == null) quietSince = now;
            if (now - quietSince >= SILENCE_HOLD_MS) {
              stopRecording();
              return;
            }
          } else {
            quietSince = null;
          }
        }
        silenceTimerRef.current = requestAnimationFrame(tick);
      };
      silenceTimerRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  function stopRecording() {
    if (silenceTimerRef.current != null) {
      cancelAnimationFrame(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    setPhase('processing');
  }

  async function onRecordingStopped(blob: Blob) {
    try {
      const resp = await voiceSearch(blob, { assetInstanceId, topK: 8 });
      setResponse(resp);
      setPhase('ready');
      // Auto-play the spoken preview. Best-effort: if TTS errors, we
      // still show the list; if the browser refuses autoplay, the
      // user sees the text and can tap Replay.
      if (resp.spokenPreview.text) {
        void playPreview(resp.spokenPreview.text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  async function playPreview(text: string) {
    if (ttsAbortRef.current) ttsAbortRef.current.abort();
    const abort = new AbortController();
    ttsAbortRef.current = abort;
    try {
      const res = await speak(text, { signal: abort.signal });
      const audioBlob = await res.blob();
      const url = URL.createObjectURL(audioBlob);
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.src = '';
      }
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play().catch(() => {
        // Autoplay refused — silently fall back to text.
      });
    } catch {
      // TTS failed or aborted — non-fatal, the list still renders.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 text-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Search size={16} className="text-white/70" />
          <span className="text-sm font-semibold tracking-wide">Voice search</span>
        </div>
        <button
          type="button"
          onClick={() => {
            teardown();
            onClose();
          }}
          aria-label="Close voice search"
          className="rounded-full p-1.5 text-white/70 hover:bg-white/10"
        >
          <X size={18} />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-5">
        {phase === 'idle' && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-12 text-center">
            <p className="text-sm text-white/80">
              Tap the mic and ask a question — &ldquo;how do I bleed the chiller pump&rdquo;, &ldquo;what is the torque spec for the cover bolt&rdquo;.
            </p>
            <button
              type="button"
              onClick={() => void startRecording()}
              className="grid size-24 place-items-center rounded-full bg-[rgb(var(--brand))] text-white shadow-xl transition active:scale-95"
              aria-label="Start recording"
            >
              <Mic size={36} />
            </button>
            <p className="text-xs text-white/50">
              Recording stops automatically after a second of silence.
            </p>
          </div>
        )}

        {phase === 'recording' && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-12 text-center">
            <button
              type="button"
              onClick={() => stopRecording()}
              className="grid size-24 place-items-center rounded-full bg-[rgb(var(--brand))] text-white shadow-xl ring-4 ring-[rgb(var(--brand))]/40 animate-pulse"
              aria-label="Stop recording"
            >
              <Mic size={36} />
            </button>
            <p className="text-sm font-medium text-white">Listening…</p>
            <p className="text-xs text-white/50">Tap to stop early.</p>
          </div>
        )}

        {phase === 'processing' && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
            <Loader2 className="animate-spin text-white/80" size={28} />
            <p className="text-sm text-white/70">Searching…</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="mx-auto flex max-w-md flex-col gap-3 py-8">
            <p className="text-sm text-red-300">{error ?? 'Something went wrong.'}</p>
            <button
              type="button"
              onClick={() => void startRecording()}
              className="self-start rounded-md border border-white/30 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
            >
              Try again
            </button>
          </div>
        )}

        {phase === 'ready' && response && (
          <div className="mx-auto flex max-w-md flex-col gap-4">
            {response.transcript && (
              <p className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs italic text-white/80">
                &ldquo;{response.transcript}&rdquo;
              </p>
            )}
            {response.spokenPreview.text && (
              <div className="flex items-start gap-2 rounded-md bg-white/5 px-3 py-2">
                <Volume2 size={14} className="mt-0.5 shrink-0 text-white/70" />
                <p className="flex-1 text-sm text-white/90">
                  {response.spokenPreview.text}
                </p>
                <button
                  type="button"
                  onClick={() => void playPreview(response.spokenPreview.text)}
                  aria-label="Replay spoken preview"
                  className="text-[10px] uppercase tracking-wider text-white/60 hover:text-white"
                >
                  Replay
                </button>
              </div>
            )}
            {response.results.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-white/70">No matches yet.</p>
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  className="rounded-md border border-white/30 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
                >
                  Try a different phrase
                </button>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {response.results.map((r, i) => (
                  <li key={r.id}>
                    <ResultCard
                      result={r}
                      emphasized={i === 0 && response.spokenPreview.confidence === 'confident'}
                      onTap={() => {
                        teardown();
                        onJump(r);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => void startRecording()}
              className="mx-auto mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/30 px-4 py-1.5 text-xs font-medium text-white hover:bg-white/10"
            >
              <Mic size={12} /> Search again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function ResultCard({
  result,
  emphasized,
  onTap,
}: {
  result: VoiceSearchResult;
  emphasized: boolean;
  onTap: () => void;
}) {
  const Icon = result.sourceType === 'procedure_step' ? ShieldAlert : FileText;
  const subtitle = [result.docTitle, result.sectionTitle].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onTap}
      className={[
        'flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition',
        emphasized
          ? 'border border-[rgb(var(--brand))]/60 bg-[rgb(var(--brand))]/15 text-white shadow-lg'
          : 'border border-white/15 bg-white/5 text-white/90 hover:bg-white/10',
      ].join(' ')}
    >
      <Icon
        size={16}
        className={['mt-0.5 shrink-0', emphasized ? 'text-[rgb(var(--brand))]' : 'text-white/60'].join(' ')}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{result.title || '(untitled)'}</p>
        {subtitle && (
          <p className="mt-0.5 truncate text-[11px] text-white/60">{subtitle}</p>
        )}
        <p className="mt-1 line-clamp-2 text-[11px] text-white/70">{result.snippet}</p>
      </div>
      <ArrowRight
        size={14}
        className={['mt-1 shrink-0', emphasized ? 'text-[rgb(var(--brand))]' : 'text-white/40'].join(' ')}
      />
    </button>
  );
}
