'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  FileUp,
  Loader2,
  Play,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  submitProcedureDraft,
  uploadDraftVideoToMuxFromPwa,
} from '@/lib/api';

// VideoSubmission — full-screen overlay for filming + submitting a
// walkthrough on the PWA. Flow:
//
//   1. Tech enters a title and (optional) notes.
//   2. Tap the camera button → device's native camera opens (we use
//      `<input accept="video/*" capture="environment">` which all modern
//      iOS/Android browsers honor). Or drop a pre-recorded clip.
//   3. We POST to /pwa/procedure-drafts to get a Mux Direct Upload URL,
//      then PUT the file bytes to Mux with a progress bar.
//   4. Show a "Submitted!" confirmation. The admin sees the run in
//      pending_admin_decision and decides whether to spend on AI.

const MAX_BYTES = 2 * 1024 * 1024 * 1024;

type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'done'; runId: string }
  | { kind: 'error'; message: string };

interface Props {
  assetInstanceId: string;
  devUserId: string;
  devOrgId: string;
  onClose: () => void;
}

export function VideoSubmission({
  assetInstanceId,
  devUserId,
  devOrgId,
  onClose,
}: Props) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Esc closes (when nothing's mid-flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && phase.kind !== 'submitting' && phase.kind !== 'uploading') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase.kind, onClose]);

  function pickFile(f: File | null) {
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) {
      setPhase({ kind: 'error', message: 'Pick a video file (MP4, MOV, WEBM).' });
      return;
    }
    if (f.size > MAX_BYTES) {
      setPhase({
        kind: 'error',
        message: 'Maximum 2 GB. Try a shorter clip or lower resolution.',
      });
      return;
    }
    setPhase({ kind: 'idle' });
    setFile(f);
  }

  async function submit() {
    if (!title.trim()) {
      setPhase({ kind: 'error', message: 'Enter a title for what this walkthrough covers.' });
      return;
    }
    if (!file) {
      setPhase({ kind: 'error', message: 'Record or pick a video first.' });
      return;
    }
    try {
      setPhase({ kind: 'submitting' });
      const { runId, uploadUrl } = await submitProcedureDraft({
        assetInstanceId,
        proposedTitle: title.trim(),
        notes: notes.trim() || undefined,
        devUserId,
        devOrgId,
      });
      setPhase({ kind: 'uploading', progress: 0 });
      await uploadDraftVideoToMuxFromPwa(uploadUrl, file, (frac) => {
        setPhase({ kind: 'uploading', progress: frac });
      });
      setPhase({ kind: 'done', runId });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const uploading = phase.kind === 'submitting' || phase.kind === 'uploading';
  const progressPct =
    phase.kind === 'uploading' ? Math.round(phase.progress * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Video size={16} className="text-white/70" />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-wide">
              Submit a walkthrough
            </span>
            <span className="text-[10px] uppercase tracking-wider text-white/40">
              Admin reviews · AI runs on approval
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={uploading}
          aria-label="Close"
          className="rounded-full p-1.5 text-white/70 hover:bg-white/10 disabled:opacity-30"
        >
          <X size={18} />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-5">
        {phase.kind === 'done' ? (
          <DoneState onClose={onClose} runId={phase.runId} />
        ) : (
          <div className="mx-auto flex max-w-md flex-col gap-4">
            <Field label="Title">
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={uploading}
                maxLength={200}
                autoFocus
                placeholder="e.g. Replace the take-up belt"
                className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[rgb(var(--brand))]"
              />
            </Field>
            <Field label="Notes (optional)" hint="Anything specific the admin should know.">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={uploading}
                maxLength={1000}
                rows={3}
                placeholder="e.g. Belt was visibly cracked; replacement on hand."
                className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/40 focus:border-[rgb(var(--brand))]"
              />
            </Field>
            <Field label="Video">
              {file ? (
                <div className="flex items-start gap-3 rounded-md border border-white/15 bg-white/5 px-3 py-3">
                  <Play size={16} className="mt-0.5 shrink-0 text-[rgb(var(--brand))]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="mt-0.5 text-[11px] text-white/60">
                      {formatBytes(file.size)} · {file.type || 'video'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    disabled={uploading}
                    className="rounded p-1 text-white/60 hover:bg-white/10 disabled:opacity-30"
                    aria-label="Remove"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => cameraRef.current?.click()}
                    disabled={uploading}
                    className="flex flex-col items-center justify-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-6 text-sm font-medium text-white transition hover:border-[rgb(var(--brand))] hover:bg-[rgb(var(--brand))]/10 disabled:opacity-40"
                  >
                    <Camera size={28} strokeWidth={1.5} />
                    <span>Record now</span>
                    <span className="text-[10px] text-white/50">Native camera</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => galleryRef.current?.click()}
                    disabled={uploading}
                    className="flex flex-col items-center justify-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-6 text-sm font-medium text-white transition hover:border-[rgb(var(--brand))] hover:bg-[rgb(var(--brand))]/10 disabled:opacity-40"
                  >
                    <FileUp size={28} strokeWidth={1.5} />
                    <span>Pick existing</span>
                    <span className="text-[10px] text-white/50">From gallery</span>
                  </button>
                </div>
              )}
              {/* Hidden inputs: capture="environment" hints the device to
                  open the rear camera. iOS Safari respects it; Chrome
                  honors `capture` to open camera-only picker. */}
              <input
                ref={cameraRef}
                type="file"
                accept="video/*"
                capture="environment"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <input
                ref={galleryRef}
                type="file"
                accept="video/*"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </Field>

            {phase.kind === 'uploading' && (
              <div className="rounded-md border border-white/15 bg-white/5 px-3 py-2">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/70">
                  <span>Uploading</span>
                  <span className="font-mono tabular-nums">{progressPct}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full bg-[rgb(var(--brand))] transition-[width] duration-200"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {phase.kind === 'error' && (
              <p className="rounded-md border border-red-300/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {phase.message}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={uploading}
                className="rounded-md border border-white/20 px-3 py-2 text-sm font-medium text-white/80 hover:bg-white/5 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={uploading || !title.trim() || !file}
                className="inline-flex items-center gap-1.5 rounded-md bg-[rgb(var(--brand))] px-4 py-2 text-sm font-semibold text-white shadow-md transition active:scale-95 disabled:opacity-40"
              >
                {phase.kind === 'submitting' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Submitting…
                  </>
                ) : phase.kind === 'uploading' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Uploading {progressPct}%
                  </>
                ) : (
                  <>
                    <Upload size={14} /> Submit walkthrough
                  </>
                )}
              </button>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-white/50">
              Your video uploads to a private server. An admin reviews the
              transcript, then decides whether to run the AI to draft a
              procedure. Nothing publishes until they approve.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function DoneState({ runId: _runId, onClose }: { runId: string; onClose: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-10 text-center">
      <CheckCircle2 size={48} className="text-[rgb(var(--brand))]" />
      <h2 className="text-lg font-semibold">Submitted</h2>
      <p className="text-sm text-white/70">
        An admin will review your walkthrough and decide whether to run
        the AI on it. You don&rsquo;t need to do anything else.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 rounded-full bg-[rgb(var(--brand))] px-5 py-2 text-sm font-semibold text-white shadow-md transition active:scale-95"
      >
        Done
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
        {label}
      </span>
      {hint && <span className="text-[11px] text-white/50">{hint}</span>}
      {children}
    </label>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
