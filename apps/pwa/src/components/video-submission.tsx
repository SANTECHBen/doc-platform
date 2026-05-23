'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  FileUp,
  Lightbulb,
  Loader2,
  Mic,
  RotateCcw,
  Smartphone,
  Upload,
  Video,
  X,
} from 'lucide-react';
import {
  submitProcedureDraft,
  uploadDraftVideoToMuxFromPwa,
} from '@/lib/api';

// VideoSubmission — full-screen overlay for filming + submitting a
// walkthrough on the PWA.
//
// Multi-screen flow:
//   1. "Coach" screen — what to film, framing tips, orientation guidance.
//      Tech taps Continue to start.
//   2. "Capture" screen — title input, camera button, preview after
//      capture with re-record affordance.
//   3. "Submitting" — upload progress with bytes/sec readout.
//   4. "Done" — success summary with thumbnail snippet from the file.
//
// We use `<input type="file" accept="video/*" capture="environment">` for
// capture — all modern iOS/Android browsers honor it and open the rear
// camera. Orientation comes from the device sensor; we detect it from
// the file's metadata (loadedmetadata → videoWidth/videoHeight) and show
// the tech a confirmation so they know what they captured.

const MAX_BYTES = 2 * 1024 * 1024 * 1024;

type Phase =
  | { kind: 'coach' }
  | { kind: 'capture' }
  | { kind: 'submitting' }
  | { kind: 'uploading'; progress: number; bytesPerSec: number }
  | { kind: 'done'; runId: string }
  | { kind: 'error'; message: string; recoverable: boolean };

interface CapturedVideo {
  file: File;
  url: string;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
}

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
  const [captured, setCaptured] = useState<CapturedVideo | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'coach' });
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const uploadStartedAt = useRef<number | null>(null);

  // Tear down object URLs when the captured video changes or the
  // component unmounts so we don't leak memory across re-records.
  useEffect(() => {
    return () => {
      if (captured?.url) URL.revokeObjectURL(captured.url);
    };
  }, [captured?.url]);

  // Esc closes (when nothing's mid-flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === 'Escape' &&
        phase.kind !== 'submitting' &&
        phase.kind !== 'uploading'
      ) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase.kind, onClose]);

  function classifyOrientation(
    w: number,
    h: number,
  ): 'portrait' | 'landscape' | 'square' {
    if (!w || !h) return 'landscape';
    if (Math.abs(w - h) / Math.max(w, h) < 0.02) return 'square';
    return w > h ? 'landscape' : 'portrait';
  }

  async function pickFile(f: File | null) {
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) {
      setPhase({
        kind: 'error',
        message: 'That doesn’t look like a video. Try MP4, MOV, or WEBM.',
        recoverable: true,
      });
      return;
    }
    if (f.size > MAX_BYTES) {
      setPhase({
        kind: 'error',
        message: 'Video is over 2 GB. Re-record a shorter clip or lower the resolution in your camera settings.',
        recoverable: true,
      });
      return;
    }
    // Probe the file so we can show orientation + duration in the
    // confirmation panel.
    const url = URL.createObjectURL(f);
    const probe = await probeVideo(url).catch(() => null);
    setCaptured({
      file: f,
      url,
      orientation: probe
        ? classifyOrientation(probe.width, probe.height)
        : null,
      durationSec: probe?.duration ?? null,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
    });
    setPhase({ kind: 'capture' });
  }

  function reset() {
    if (captured?.url) URL.revokeObjectURL(captured.url);
    setCaptured(null);
  }

  async function submit() {
    if (!title.trim()) {
      setPhase({
        kind: 'error',
        message: 'Add a quick title — what does this walkthrough cover?',
        recoverable: true,
      });
      return;
    }
    if (!captured?.file) {
      setPhase({
        kind: 'error',
        message: 'Record or pick a video first.',
        recoverable: true,
      });
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
      uploadStartedAt.current = Date.now();
      setPhase({ kind: 'uploading', progress: 0, bytesPerSec: 0 });
      await uploadDraftVideoToMuxFromPwa(uploadUrl, captured.file, (frac) => {
        const start = uploadStartedAt.current ?? Date.now();
        const elapsed = Math.max(1, (Date.now() - start) / 1000);
        const bytes = frac * captured.file.size;
        setPhase({
          kind: 'uploading',
          progress: frac,
          bytesPerSec: bytes / elapsed,
        });
      });
      setPhase({ kind: 'done', runId });
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        recoverable: true,
      });
    }
  }

  const uploading = phase.kind === 'submitting' || phase.kind === 'uploading';
  const progressPct =
    phase.kind === 'uploading' ? Math.round(phase.progress * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="grid place-items-center rounded-full bg-[rgb(var(--brand))]/15 p-1.5">
            <Video size={16} className="text-[rgb(var(--brand))]" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-wide">
              {phase.kind === 'done'
                ? 'Submitted'
                : phase.kind === 'coach'
                  ? 'Film a walkthrough'
                  : 'Submit walkthrough'}
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

      <main className="flex-1 overflow-y-auto">
        {phase.kind === 'coach' && (
          <CoachScreen onContinue={() => setPhase({ kind: 'capture' })} />
        )}

        {(phase.kind === 'capture' ||
          phase.kind === 'error' ||
          phase.kind === 'submitting' ||
          phase.kind === 'uploading') && (
          <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5">
            <Field label="Title" required>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={uploading}
                maxLength={200}
                autoFocus
                placeholder="e.g. Replace the take-up belt"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-3 text-base text-white outline-none placeholder:text-white/40 focus:border-[rgb(var(--brand))]"
              />
            </Field>
            <Field
              label="Notes"
              hint="Anything specific the admin should know — context, follow-ups."
            >
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={uploading}
                maxLength={1000}
                rows={2}
                placeholder="e.g. Belt was visibly cracked; replacement on hand."
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/40 focus:border-[rgb(var(--brand))]"
              />
            </Field>
            <Field label="Video" required>
              {captured ? (
                <CapturedPreview
                  captured={captured}
                  disabled={uploading}
                  onRetake={() => {
                    reset();
                    cameraRef.current?.click();
                  }}
                  onPickAgain={() => {
                    reset();
                  }}
                />
              ) : (
                <CapturePicker
                  disabled={uploading}
                  onRecord={() => cameraRef.current?.click()}
                  onPick={() => galleryRef.current?.click()}
                />
              )}
              <input
                ref={cameraRef}
                type="file"
                accept="video/*"
                capture="environment"
                onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              <input
                ref={galleryRef}
                type="file"
                accept="video/*"
                onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </Field>

            {phase.kind === 'uploading' && (
              <UploadProgress
                progressPct={progressPct}
                bytesPerSec={phase.bytesPerSec}
                bytesTotal={captured?.file.size ?? 0}
              />
            )}

            {phase.kind === 'error' && (
              <div className="flex items-start gap-2 rounded-lg border border-red-300/40 bg-red-500/10 px-3 py-2.5">
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0 text-red-300"
                />
                <p className="text-xs text-red-100">{phase.message}</p>
              </div>
            )}

            <div className="sticky bottom-0 -mx-4 -mb-5 mt-2 flex items-center justify-end gap-2 border-t border-white/10 bg-gradient-to-t from-black to-black/80 px-4 py-3">
              <button
                type="button"
                onClick={onClose}
                disabled={uploading}
                className="rounded-lg border border-white/20 px-3 py-2.5 text-sm font-medium text-white/80 hover:bg-white/5 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={uploading || !title.trim() || !captured}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--brand))] px-4 py-3 text-sm font-semibold text-white shadow-lg transition active:scale-[0.98] disabled:opacity-40"
              >
                {phase.kind === 'submitting' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Preparing…
                  </>
                ) : phase.kind === 'uploading' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Uploading {progressPct}%
                  </>
                ) : (
                  <>
                    <Upload size={14} /> Send for review
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {phase.kind === 'done' && (
          <DoneState
            onClose={onClose}
            runId={phase.runId}
            captured={captured}
          />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-screens
// ---------------------------------------------------------------------------

function CoachScreen({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6">
      <div className="rounded-2xl border border-white/15 bg-white/[0.04] p-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--brand))]">
          Before you start
        </p>
        <h2 className="mt-1 text-xl font-semibold leading-tight">
          Talk through what you’re doing — like you’re teaching a buddy.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/70">
          The AI listens to your voice and watches the action. The cleaner
          your narration, the cleaner the published procedure.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        <Tip
          icon={<Mic size={16} />}
          title="Narrate every step"
          body="Say what you’re doing before you do it — “Now I’m loosening the four 13 mm bolts.” The AI uses your words to title each step."
        />
        <Tip
          icon={<Smartphone size={16} />}
          title="Pick an orientation and stay there"
          body="Vertical or horizontal — both work, and the published player matches what you filmed. Just don’t flip mid-clip."
        />
        <Tip
          icon={<Clock size={16} />}
          title="Keep it under ~10 minutes"
          body="One procedure per clip. If you need a tool break, pause your story and resume."
        />
        <Tip
          icon={<Lightbulb size={16} />}
          title="Call out safety verbally"
          body="“PPE on,” “locked out,” “1500 PSI hot side.” Safety language becomes a callout the tech can’t miss."
        />
      </ul>

      <button
        type="button"
        onClick={onContinue}
        className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--brand))] px-4 py-3 text-sm font-semibold text-white shadow-lg active:scale-[0.98]"
      >
        Got it — let’s film
      </button>
    </div>
  );
}

function Tip({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[rgb(var(--brand))]/15 text-[rgb(var(--brand))]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-snug">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-white/65">{body}</p>
      </div>
    </li>
  );
}

function CapturePicker({
  disabled,
  onRecord,
  onPick,
}: {
  disabled: boolean;
  onRecord: () => void;
  onPick: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr]">
      <button
        type="button"
        onClick={onRecord}
        disabled={disabled}
        className="group flex items-center justify-center gap-3 rounded-xl border-2 border-[rgb(var(--brand))]/40 bg-[rgb(var(--brand))]/10 px-4 py-5 text-base font-semibold text-white transition hover:border-[rgb(var(--brand))] hover:bg-[rgb(var(--brand))]/20 disabled:opacity-40"
      >
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[rgb(var(--brand))] text-white shadow-md group-hover:scale-105">
          <Camera size={20} strokeWidth={2} />
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span>Record now</span>
          <span className="text-[10px] font-normal text-white/55">
            Opens device camera
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        className="flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-4 text-sm font-medium text-white hover:border-white/30 hover:bg-white/10 disabled:opacity-40"
      >
        <FileUp size={16} />
        <span>From gallery</span>
      </button>
    </div>
  );
}

function CapturedPreview({
  captured,
  disabled,
  onRetake,
  onPickAgain,
}: {
  captured: CapturedVideo;
  disabled: boolean;
  onRetake: () => void;
  onPickAgain: () => void;
}) {
  const orientationLabel =
    captured.orientation === 'portrait'
      ? 'Vertical'
      : captured.orientation === 'landscape'
        ? 'Horizontal'
        : captured.orientation === 'square'
          ? 'Square'
          : 'Unknown';

  return (
    <div className="overflow-hidden rounded-xl border border-white/15 bg-white/[0.03]">
      <div
        className={
          'relative bg-black ' +
          (captured.orientation === 'portrait' ? 'mx-auto max-w-[260px]' : '')
        }
        style={{
          aspectRatio:
            captured.width && captured.height
              ? `${captured.width} / ${captured.height}`
              : '16 / 9',
        }}
      >
        <video
          src={captured.url}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-contain"
        />
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur">
          {orientationLabel}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{captured.file.name}</p>
          <p className="mt-0.5 text-[11px] text-white/55">
            {formatBytes(captured.file.size)}
            {captured.durationSec != null
              ? ` · ${formatDuration(captured.durationSec)}`
              : ''}
            {captured.width && captured.height
              ? ` · ${captured.width}×${captured.height}`
              : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onRetake}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1.5 text-xs font-semibold text-white/80 hover:border-[rgb(var(--brand))]/50 hover:bg-[rgb(var(--brand))]/10 hover:text-white disabled:opacity-40"
          aria-label="Re-record"
        >
          <RotateCcw size={12} /> Retake
        </button>
        <button
          type="button"
          onClick={onPickAgain}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/10 disabled:opacity-40"
          aria-label="Pick a different video"
        >
          <X size={12} /> Discard
        </button>
      </div>
    </div>
  );
}

function UploadProgress({
  progressPct,
  bytesPerSec,
  bytesTotal,
}: {
  progressPct: number;
  bytesPerSec: number;
  bytesTotal: number;
}) {
  const remainingBytes = Math.max(0, bytesTotal * (1 - progressPct / 100));
  const etaSec = bytesPerSec > 1000 ? remainingBytes / bytesPerSec : null;
  return (
    <div className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/70">
        <span className="font-semibold">Uploading to secure server</span>
        <span className="font-mono tabular-nums">{progressPct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full bg-[rgb(var(--brand))] transition-[width] duration-200"
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-white/50">
        {formatRate(bytesPerSec)}
        {etaSec != null ? ` · ~${formatDuration(etaSec)} left` : ''}
      </p>
    </div>
  );
}

function DoneState({
  runId: _runId,
  onClose,
  captured,
}: {
  runId: string;
  onClose: () => void;
  captured: CapturedVideo | null;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-12 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-full bg-[rgb(var(--brand))]/15">
        <CheckCircle2 size={42} className="text-[rgb(var(--brand))]" />
      </div>
      <h2 className="text-xl font-semibold">Sent for review</h2>
      <p className="max-w-xs text-sm leading-relaxed text-white/70">
        An admin will watch the clip and decide whether to run the AI on
        it. You don’t need to do anything else.
      </p>
      {captured?.url && (
        <div className="w-full max-w-xs overflow-hidden rounded-xl border border-white/10 bg-black">
          <video
            src={captured.url}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full"
            style={{
              aspectRatio:
                captured.width && captured.height
                  ? `${captured.width} / ${captured.height}`
                  : '16 / 9',
            }}
          />
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-white/50">
        <Check size={12} /> Encrypted at rest in Mux
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--brand))] px-5 py-3 text-sm font-semibold text-white shadow-md transition active:scale-[0.98]"
      >
        Done
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/60">
        {label}
        {required && (
          <span aria-hidden className="text-[rgb(var(--brand))]">
            *
          </span>
        )}
      </span>
      {hint && <span className="text-[11px] text-white/50">{hint}</span>}
      {children}
    </label>
  );
}

function probeVideo(
  url: string,
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    probe.src = url;
    probe.onloadedmetadata = () => {
      resolve({
        width: probe.videoWidth || 0,
        height: probe.videoHeight || 0,
        duration: probe.duration || 0,
      });
      // Don't tear down — the URL is still in use by the visible
      // <video> element. The component cleans the object URL on unmount.
    };
    probe.onerror = () => reject(new Error('probe failed'));
    // Hard timeout — some Android browsers stall metadata on HEVC.
    setTimeout(() => reject(new Error('probe timeout')), 5000);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}
