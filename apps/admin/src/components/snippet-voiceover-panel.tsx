'use client';

// SnippetVoiceoverPanel — mirrors the procedure-step VoiceoverPanel but
// targets the /admin/snippets/:id/audio endpoints. Same UX trio:
//
//   1. AI generate          tts-1-hd synthesizes from title + blocks
//   2. Upload                drag-drop / file-pick MP3, M4A, AAC, OGG, WAV
//   3. Record in browser     mic capture; uploads on stop
//
// The runner inherits this audio at play time when a snippet-attached
// step has no audio of its own — so a single LOTO snippet edit
// propagates the voiceover across every procedure that uses it.

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
  deleteSnippetAudio,
  generateSnippetAudio,
  patchSnippetAudioDuration,
  uploadSnippetAudio,
  type AdminSnippetDetail,
} from '@/lib/api';

interface Props {
  snippet: AdminSnippetDetail;
  onChanged: (next: AdminSnippetDetail) => void;
  /** When true (platform snippet without platform-admin), all mutation
   *  buttons are disabled with a tooltip explaining why. */
  readOnly?: boolean;
}

type Phase = 'idle' | 'uploading' | 'generating' | 'recording' | 'deleting' | 'error';

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function probeDurationLater(
  url: string,
  snippetId: string,
  base: AdminSnippetDetail,
  onChanged: (n: AdminSnippetDetail) => void,
) {
  const a = new Audio(url);
  a.preload = 'metadata';
  a.addEventListener('loadedmetadata', () => {
    const ms = Math.round((a.duration || 0) * 1000);
    if (!Number.isFinite(ms) || ms <= 0) return;
    onChanged({ ...base, audioDurationMs: ms });
    void patchSnippetAudioDuration(snippetId, ms).catch(() => {
      // server-side PATCH is best-effort; the on-screen value still
      // reflects the probe even if the round-trip fails.
    });
  });
}

export function SnippetVoiceoverPanel({ snippet, onChanged, readOnly = false }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (audioRef.current && snippet.audioUrl) {
      audioRef.current.src = snippet.audioUrl;
      audioRef.current.load();
    }
    setPlaying(false);
  }, [snippet.audioUrl]);

  function fail(prefix: string, e: unknown) {
    setError(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
    setPhase('error');
  }

  async function onGenerate() {
    setError(null);
    setPhase('generating');
    try {
      const r = await generateSnippetAudio(snippet.id);
      const next: AdminSnippetDetail = {
        ...snippet,
        audioStorageKey: 'set',
        audioContentType: r.audioContentType,
        audioSizeBytes: r.audioSizeBytes,
        audioSource: r.audioSource,
        audioUrl: r.audioUrl,
        audioDurationMs: null,
      };
      onChanged(next);
      setPhase('idle');
      void probeDurationLater(r.audioUrl, snippet.id, next, onChanged);
    } catch (e) {
      fail('Could not generate audio', e);
    }
  }

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
      const r = await uploadSnippetAudio(snippet.id, file);
      const next: AdminSnippetDetail = {
        ...snippet,
        audioStorageKey: 'set',
        audioContentType: r.audioContentType,
        audioSizeBytes: r.audioSizeBytes,
        audioSource: r.audioSource,
        audioUrl: r.audioUrl,
        audioDurationMs: null,
      };
      onChanged(next);
      setPhase('idle');
      void probeDurationLater(r.audioUrl, snippet.id, next, onChanged);
    } catch (err) {
      fail('Upload failed', err);
    }
  }

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
        for (const tr of recordStreamRef.current?.getTracks() ?? []) tr.stop();
        recordStreamRef.current = null;
        if (chunks.length === 0) {
          setPhase('idle');
          return;
        }
        const blob = new Blob(chunks, { type: mime ?? 'audio/webm' });
        const file = new File([blob], `snippet-${snippet.id}-recording.webm`, {
          type: blob.type,
        });
        setPhase('uploading');
        try {
          const r = await uploadSnippetAudio(snippet.id, file);
          const next: AdminSnippetDetail = {
            ...snippet,
            audioStorageKey: 'set',
            audioContentType: r.audioContentType,
            audioSizeBytes: r.audioSizeBytes,
            audioSource: r.audioSource,
            audioUrl: r.audioUrl,
            audioDurationMs: null,
          };
          onChanged(next);
          setPhase('idle');
          void probeDurationLater(r.audioUrl, snippet.id, next, onChanged);
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

  async function onDelete() {
    if (!confirm('Delete this snippet voiceover?')) return;
    setError(null);
    setPhase('deleting');
    try {
      await deleteSnippetAudio(snippet.id);
      onChanged({
        ...snippet,
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

  const hasAudio = !!snippet.audioUrl;
  const recording = phase === 'recording';
  const busy =
    phase === 'uploading' || phase === 'generating' || phase === 'deleting';

  return (
    <div className="rounded-md border border-line bg-surface-raised">
      <header className="border-b border-line-subtle px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          Voiceover
        </p>
        <p className="mt-0.5 text-[11px] text-ink-secondary">
          Plays during the procedure runner. Inherited by every attached
          step that has no audio of its own — one edit propagates
          everywhere.
        </p>
      </header>
      <div className="flex flex-col gap-2 p-3">
        {error && (
          <p className="rounded-md border border-signal-fault/40 bg-signal-fault/5 px-2 py-1 text-xs text-signal-fault">
            {error}
          </p>
        )}

        {hasAudio && !recording && (
          <div className="flex items-center gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2">
            <button
              type="button"
              onClick={togglePlay}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:brightness-110"
              aria-label={playing ? 'Pause' : 'Play preview'}
            >
              {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-primary">
                🎧 {snippet.audioSource === 'generated' ? 'AI voice' : 'Custom voiceover'}
                {snippet.audioDurationMs ? (
                  <span className="ml-2 text-xs font-normal text-ink-tertiary">
                    {formatDuration(snippet.audioDurationMs)}
                  </span>
                ) : null}
                {snippet.audioSizeBytes != null ? (
                  <span className="ml-1 text-xs font-normal text-ink-tertiary">
                    · {formatBytes(snippet.audioSizeBytes)}
                  </span>
                ) : null}
              </p>
              <audio
                ref={audioRef}
                preload="metadata"
                onEnded={() => setPlaying(false)}
                className="hidden"
              />
            </div>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy || readOnly}
              className="rounded p-1 text-ink-tertiary transition hover:bg-signal-fault/10 hover:text-signal-fault disabled:opacity-30"
              aria-label="Delete voiceover"
              title="Delete voiceover"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <ActionButton
            onClick={() => void onGenerate()}
            disabled={busy || recording || readOnly}
            icon={phase === 'generating' ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            label={hasAudio ? 'Regenerate (AI)' : 'AI voice'}
            hint="tts-1-hd from snippet text"
          />
          <ActionButton
            onClick={() => void onPickFile()}
            disabled={busy || recording || readOnly}
            icon={phase === 'uploading' ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            label={hasAudio ? 'Replace (upload)' : 'Upload file'}
            hint="MP3 / M4A / WAV"
          />
          <ActionButton
            onClick={recording ? () => stopRecording() : () => void startRecording()}
            disabled={busy || readOnly}
            icon={recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
            label={recording ? 'Stop recording' : hasAudio ? 'Replace (record)' : 'Record'}
            hint="In-browser mic"
            tone={recording ? 'danger' : 'default'}
          />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/aac,audio/ogg,audio/webm,audio/wav,audio/x-wav,.mp3,.m4a,.aac,.ogg,.wav,.webm"
          onChange={(e) => void onFileChosen(e)}
          className="hidden"
        />

        {readOnly && (
          <p className="text-[11px] italic text-ink-tertiary">
            This is a platform snippet — only platform admins can edit the voiceover.
          </p>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  icon,
  label,
  hint,
  tone = 'default',
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-xs font-medium transition disabled:opacity-40',
        tone === 'danger'
          ? 'border-signal-fault/40 bg-signal-fault/5 text-signal-fault hover:bg-signal-fault/10'
          : 'border-line bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent',
      ].join(' ')}
    >
      <span className="inline-flex items-center gap-1.5">
        {icon}
        <span>{label}</span>
      </span>
      <span className="text-[10px] font-normal text-ink-tertiary">{hint}</span>
    </button>
  );
}
