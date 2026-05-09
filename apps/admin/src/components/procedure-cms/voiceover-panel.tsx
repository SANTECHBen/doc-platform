'use client';

// VoiceoverPanel — three coexisting authoring paths for a step's
// voiceover, plus a playback preview:
//
//   1. AI-generate           one click, TTS-1-HD synthesizes from the
//                            step's title+body, pinned to S3 forever.
//   2. Upload                drag-drop / file-pick MP3, M4A, AAC, OGG, WAV.
//   3. Record in browser     mic capture; uploads on stop. (Press to talk.)
//
// Switching between paths replaces the prior audio (one voiceover per
// step). The current audio is shown with a player + duration; "Delete"
// clears it. After upload/record, we probe duration in the browser
// (HTMLAudioElement.duration) and PATCH the server so the runner can
// schedule auto-advance reliably.

import { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Mic,
  Pause,
  Play,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  deleteProcedureStepAudio,
  generateProcedureStepAudio,
  patchProcedureStepAudioDuration,
  uploadProcedureStepAudio,
  type AdminProcedureStep,
} from '@/lib/api';

interface Props {
  step: AdminProcedureStep;
  /** Called with the updated step after any successful audio mutation. */
  onChanged: (next: AdminProcedureStep) => void;
}

type Phase = 'idle' | 'uploading' | 'generating' | 'recording' | 'deleting' | 'error';

export function VoiceoverPanel({ step, onChanged }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);

  // Keep the <audio> element in sync with the current url. Reset when the
  // step's audio source changes (upload → generate, etc.).
  useEffect(() => {
    if (audioRef.current && step.audioUrl) {
      audioRef.current.src = step.audioUrl;
      audioRef.current.load();
    }
    setPlaying(false);
  }, [step.audioUrl]);

  function fail(prefix: string, e: unknown) {
    setError(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
    setPhase('error');
  }

  // ---- AI generate -------------------------------------------------------
  async function onGenerate() {
    setError(null);
    setPhase('generating');
    try {
      const r = await generateProcedureStepAudio(step.id);
      const next: AdminProcedureStep = {
        ...step,
        audioStorageKey: 'set', // server normalizes; refresh below.
        audioContentType: r.audioContentType,
        audioSizeBytes: r.audioSizeBytes,
        audioSource: r.audioSource,
        audioUrl: r.audioUrl,
        audioDurationMs: null,
      };
      onChanged(next);
      setPhase('idle');
      // Probe duration once the file loads in the audio element.
      void probeDurationLater(r.audioUrl, step.id, next, onChanged);
    } catch (e) {
      fail('Could not generate audio', e);
    }
  }

  // ---- Upload ------------------------------------------------------------
  async function onPickFile() {
    fileInputRef.current?.click();
  }
  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    setError(null);
    setPhase('uploading');
    try {
      const r = await uploadProcedureStepAudio(step.id, file);
      const next: AdminProcedureStep = {
        ...step,
        audioStorageKey: 'set',
        audioContentType: r.audioContentType,
        audioSizeBytes: r.audioSizeBytes,
        audioSource: r.audioSource,
        audioUrl: r.audioUrl,
        audioDurationMs: null,
      };
      onChanged(next);
      setPhase('idle');
      void probeDurationLater(r.audioUrl, step.id, next, onChanged);
    } catch (err) {
      fail('Upload failed', err);
    }
  }

  // ---- Record ------------------------------------------------------------
  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      recordStreamRef.current = stream;
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorderRef.current = rec;
      recordedChunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        const chunks = recordedChunksRef.current;
        recordedChunksRef.current = [];
        for (const tr of (recordStreamRef.current?.getTracks() ?? [])) tr.stop();
        recordStreamRef.current = null;
        if (chunks.length === 0) {
          setPhase('idle');
          return;
        }
        const blob = new Blob(chunks, { type: mime ?? 'audio/webm' });
        // Wrap as a File so the API helper sees a filename.
        const file = new File([blob], `step-${step.id}-recording.webm`, {
          type: blob.type,
        });
        setPhase('uploading');
        try {
          const r = await uploadProcedureStepAudio(step.id, file);
          const next: AdminProcedureStep = {
            ...step,
            audioStorageKey: 'set',
            audioContentType: r.audioContentType,
            audioSizeBytes: r.audioSizeBytes,
            audioSource: r.audioSource,
            audioUrl: r.audioUrl,
            audioDurationMs: null,
          };
          onChanged(next);
          setPhase('idle');
          void probeDurationLater(r.audioUrl, step.id, next, onChanged);
        } catch (err) {
          fail('Recording upload failed', err);
        }
      };
      rec.start(250);
      setPhase('recording');
    } catch (err) {
      fail('Microphone access failed', err);
    }
  }
  function stopRecording() {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    }
    mediaRecorderRef.current = null;
  }

  // ---- Delete ------------------------------------------------------------
  async function onDelete() {
    if (!confirm('Delete the voiceover for this step?')) return;
    setError(null);
    setPhase('deleting');
    try {
      await deleteProcedureStepAudio(step.id);
      onChanged({
        ...step,
        audioStorageKey: null,
        audioContentType: null,
        audioSizeBytes: null,
        audioDurationMs: null,
        audioSource: null,
        audioUrl: null,
      });
      setPhase('idle');
    } catch (e) {
      fail('Could not delete audio', e);
    }
  }

  // ---- Preview playback --------------------------------------------------
  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  const hasAudio = !!step.audioUrl;
  const recording = phase === 'recording';
  const busy =
    phase === 'uploading' || phase === 'generating' || phase === 'deleting';

  return (
    <div className="rounded-md border border-line-subtle bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
          Voiceover
        </h4>
        {hasAudio && step.audioSource && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
              step.audioSource === 'generated'
                ? 'bg-accent/10 text-accent'
                : 'bg-signal-ok/10 text-signal-ok'
            }`}
          >
            {step.audioSource === 'generated' ? 'AI · regenerable' : 'Custom upload'}
          </span>
        )}
      </div>

      {/* Existing audio preview */}
      {hasAudio && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-surface-raised px-3 py-2">
          <button
            type="button"
            onClick={togglePlay}
            className="inline-flex size-9 items-center justify-center rounded-full bg-accent text-white transition hover:brightness-110"
            aria-label={playing ? 'Pause' : 'Play preview'}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink-primary">
              {step.audioSource === 'generated' ? 'AI voice' : 'Custom voiceover'}
              {step.audioDurationMs ? (
                <span className="ml-2 text-xs text-ink-tertiary">
                  {formatDuration(step.audioDurationMs)}
                </span>
              ) : null}
            </p>
            {step.audioSizeBytes != null && (
              <p className="text-xs text-ink-tertiary">
                {(step.audioSizeBytes / 1024).toFixed(0)} KB
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded p-1.5 text-ink-tertiary transition hover:bg-signal-fault/10 hover:text-signal-fault disabled:opacity-40"
            aria-label="Delete voiceover"
            title="Delete voiceover"
          >
            <Trash2 className="size-4" />
          </button>
          <audio
            ref={audioRef}
            src={step.audioUrl ?? undefined}
            onEnded={() => setPlaying(false)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            preload="metadata"
            crossOrigin="anonymous"
          />
        </div>
      )}

      {/* Action row — 3 buttons. Recording overrides everything when active. */}
      {recording ? (
        <button
          type="button"
          onClick={stopRecording}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-signal-fault px-4 py-3 text-sm font-medium text-white shadow-sm transition hover:brightness-110"
        >
          <Square className="size-4 fill-current" />
          Stop recording
          <RecordingPulse />
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ActionTile
            onClick={onGenerate}
            disabled={busy}
            icon={
              phase === 'generating' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )
            }
            label={hasAudio ? 'Re-generate with AI' : 'Generate with AI'}
            sub="Uses your TTS voice"
          />
          <ActionTile
            onClick={onPickFile}
            disabled={busy}
            icon={
              phase === 'uploading' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )
            }
            label="Upload file"
            sub="MP3 · M4A · WAV"
          />
          <ActionTile
            onClick={startRecording}
            disabled={busy}
            icon={<Mic className="size-4" />}
            label="Record now"
            sub="Use your mic"
          />
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/x-m4a,audio/aac,audio/ogg,audio/webm,audio/wav,audio/x-wav"
        onChange={onFileChosen}
        className="hidden"
      />

      {error && (
        <p className="mt-3 rounded-md border border-signal-fault/40 bg-signal-fault/10 px-3 py-2 text-xs text-signal-fault">
          {error}
        </p>
      )}
    </div>
  );
}

function ActionTile({
  onClick,
  disabled,
  icon,
  label,
  sub,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col items-start gap-1 rounded-md border border-line-subtle bg-surface-raised px-3 py-2.5 text-left transition hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-primary">
        <span className="text-ink-secondary group-hover:text-accent">{icon}</span>
        {label}
      </span>
      <span className="text-xs text-ink-tertiary">{sub}</span>
    </button>
  );
}

function RecordingPulse() {
  return (
    <span
      aria-hidden
      className="ml-2 inline-block size-2 rounded-full bg-white opacity-90"
      style={{ animation: 'voPulse 1.2s ease-in-out infinite' }}
    >
      <style>{`@keyframes voPulse{0%,100%{opacity:.4}50%{opacity:1}}`}</style>
    </span>
  );
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Off-thread duration probe — load the audio in a hidden element, read
// duration once metadata arrives, PATCH the server. The runner uses this
// to schedule auto-advance reliably.
function probeDurationLater(
  url: string,
  stepId: string,
  next: AdminProcedureStep,
  onChanged: (s: AdminProcedureStep) => void,
) {
  if (typeof window === 'undefined') return;
  const probe = new Audio();
  probe.preload = 'metadata';
  probe.crossOrigin = 'anonymous';
  probe.src = url;
  probe.addEventListener(
    'loadedmetadata',
    () => {
      const ms = Math.round((probe.duration || 0) * 1000);
      if (ms > 0) {
        onChanged({ ...next, audioDurationMs: ms });
        void patchProcedureStepAudioDuration(stepId, ms).catch(() => {});
      }
    },
    { once: true },
  );
  // Kick metadata fetch.
  probe.load();
}
