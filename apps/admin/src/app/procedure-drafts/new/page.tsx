'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Clapperboard,
  FileText,
  FileUp,
  Loader2,
  Play,
  Upload,
  X,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
import {
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
} from '@/components/form';
import {
  createProcedureDraft,
  createProcedureDraftDocument,
  getContentPack,
  listContentPacks,
  listOrganizations,
  uploadDraftVideoToMux,
  type AdminContentPack,
  type AdminContentPackDetail,
  type AdminOrganization,
} from '@/lib/api';

// /procedure-drafts/new — guided flow for starting a new AI video draft.
//
//   1. Pick a target: org → content pack → version.
//   2. Drop or select an MP4 / MOV / WEBM walkthrough (≤2 GB, ≤30 min).
//   3. We POST to /admin/procedure-drafts to get a Mux Direct Upload URL,
//      then PUT the file bytes straight from the browser. Progress
//      streams via XHR.
//   4. On upload completion, redirect to the reviewer — Mux will
//      transcribe + propose steps automatically and the reviewer page
//      polls for status updates.
//
// We keep the page as a single client component because every step
// depends on the prior selection (versions need the pack id, etc.), and
// a multi-page wizard for what is effectively one form would add more
// friction than it removes for a power-user-facing surface.

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB hard cap
const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];
const ACCEPTED_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v', '.mkv'];

// Document-import path: a Word/PDF procedure the AI restructures into steps.
type SourceMode = 'video' | 'document';
const MAX_DOC_BYTES = 50 * 1024 * 1024; // 50 MB
const DOC_ACCEPTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const DOC_ACCEPTED_EXTENSIONS = ['.pdf', '.docx'];

type UploadPhase =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'finishing' }
  | { kind: 'error'; message: string };

export default function NewProcedureDraftPage() {
  const router = useRouter();
  const toast = useToast();

  const [orgs, setOrgs] = useState<AdminOrganization[]>([]);
  const [packs, setPacks] = useState<AdminContentPack[] | null>(null);
  const [packDetail, setPackDetail] = useState<AdminContentPackDetail | null>(null);

  const [sourceMode, setSourceMode] = useState<SourceMode>('video');
  const [title, setTitle] = useState('');
  const [ownerId, setOwnerId] = useState<string>('');
  const [packId, setPackId] = useState<string>('');
  const [versionId, setVersionId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);

  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  const [pageError, setPageError] = useState<string | null>(null);

  // ---------- Initial data load ----------
  useEffect(() => {
    void (async () => {
      try {
        const [organizations, allPacks] = await Promise.all([
          listOrganizations(),
          listContentPacks(),
        ]);
        setOrgs(organizations);
        setPacks(allPacks);
        if (!ownerId && organizations.length > 0) setOwnerId(organizations[0]!.id);
      } catch (e) {
        setPageError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Filter packs by selected org ----------
  const packsForOrg = useMemo(() => {
    if (!packs) return [];
    if (!ownerId) return packs;
    // listContentPacks DTO carries `owner` as a string label (org name).
    // For an unambiguous filter we'd need ownerOrganizationId on the row;
    // since it isn't there, we drop the org filter and just rely on the
    // pack picker to render every pack the caller has read access to.
    // Server-side scope already gates the list.
    return packs;
  }, [packs, ownerId]);

  // Default-select the first pack once they load. Don't lock the user in
  // if they switch orgs.
  useEffect(() => {
    if (!packId && packsForOrg.length > 0) {
      setPackId(packsForOrg[0]!.id);
    }
  }, [packsForOrg, packId]);

  // ---------- Load full pack detail (for versions) when packId changes ----------
  useEffect(() => {
    if (!packId) {
      setPackDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await getContentPack(packId);
        if (!cancelled) {
          setPackDetail(detail);
          // Pick the latest DRAFT version by default; otherwise pick the
          // latest published. Drafts are the right default — published
          // versions are immutable in the rest of the system, but step
          // edits ARE allowed on published; we still prefer draft when
          // available to keep the new procedure cleanly authorable.
          if (detail) {
            const versions = detail.versions ?? [];
            const draft = versions.find((v) => v.status === 'draft');
            const fallback = versions[0];
            const picked = draft ?? fallback;
            if (picked) setVersionId(picked.id);
          }
        }
      } catch (e) {
        if (!cancelled) setPageError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packId]);

  // ---------- File pick / drop ----------
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function pickFile(picked: File | null) {
    if (!picked) {
      setFile(null);
      return;
    }
    const ext = picked.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
    if (sourceMode === 'document') {
      const okDoc =
        DOC_ACCEPTED_TYPES.includes(picked.type) ||
        DOC_ACCEPTED_EXTENSIONS.includes(ext);
      if (!okDoc) {
        toast.error('Unsupported file', `Expected a Word (.docx) or PDF file. Got "${picked.type || ext}".`);
        return;
      }
      if (picked.size > MAX_DOC_BYTES) {
        toast.error('Too large', 'Maximum 50 MB for documents.');
        return;
      }
      setFile(picked);
      return;
    }
    const okMime =
      ACCEPTED_TYPES.includes(picked.type) || ACCEPTED_EXTENSIONS.includes(ext);
    if (!okMime) {
      toast.error('Unsupported file', `Expected MP4 / MOV / WEBM. Got "${picked.type || ext}".`);
      return;
    }
    if (picked.size > MAX_BYTES) {
      toast.error('Too large', 'Maximum 2 GB. Trim the recording or transcode to a lower bitrate.');
      return;
    }
    setFile(picked);
  }

  // Switching source mode clears a now-invalid file pick.
  function switchMode(mode: SourceMode) {
    if (mode === sourceMode) return;
    setSourceMode(mode);
    setFile(null);
  }

  // ---------- Submit ----------
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPageError(null);
    if (!title.trim()) {
      setPageError('Title is required.');
      return;
    }
    if (!ownerId) {
      setPageError('Pick an organization.');
      return;
    }
    if (!versionId) {
      setPageError('Pick a content pack version.');
      return;
    }
    if (!file) {
      setPageError(
        sourceMode === 'document'
          ? 'Choose a Word or PDF document to upload.'
          : 'Choose a video file to upload.',
      );
      return;
    }
    try {
      if (sourceMode === 'document') {
        setPhase({ kind: 'uploading', progress: 0 });
        const { runId } = await createProcedureDraftDocument({
          proposedTitle: title.trim(),
          targetContentPackVersionId: versionId,
          ownerOrganizationId: ownerId,
          file,
          onProgress: (frac) => setPhase({ kind: 'uploading', progress: frac }),
        });
        setPhase({ kind: 'finishing' });
        toast.success('Uploaded', 'Parsing the document and extracting figures…');
        router.push(`/procedure-drafts/${runId}`);
        return;
      }
      setPhase({ kind: 'creating' });
      const { runId, uploadUrl } = await createProcedureDraft({
        proposedTitle: title.trim(),
        targetContentPackVersionId: versionId,
        ownerOrganizationId: ownerId,
      });
      setPhase({ kind: 'uploading', progress: 0 });
      await uploadDraftVideoToMux(uploadUrl, file, (frac) => {
        setPhase({ kind: 'uploading', progress: frac });
      });
      setPhase({ kind: 'finishing' });
      toast.success('Uploaded', 'Mux will start processing in a moment.');
      router.push(`/procedure-drafts/${runId}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPhase({ kind: 'error', message });
      toast.error('Upload failed', message);
    }
  }

  const uploading = phase.kind === 'creating' || phase.kind === 'uploading' || phase.kind === 'finishing';
  const progressLabel = phase.kind === 'uploading' ? `${Math.round(phase.progress * 100)}%` : '';

  // Versions to show in the picker. Drafts first, then published.
  const versions = useMemo(() => {
    if (!packDetail) return [];
    const v = [...(packDetail.versions ?? [])];
    v.sort((a, b) => {
      // Prefer draft over published. Within a status, latest versionNumber first.
      if (a.status !== b.status) return a.status === 'draft' ? -1 : 1;
      return b.versionNumber - a.versionNumber;
    });
    return v;
  }, [packDetail]);

  return (
    <PageShell
      crumbs={[
        { label: 'AI drafts', href: '/procedure-drafts' },
        { label: 'New' },
      ]}
    >
      <div className="mb-3">
        <Link
          href="/procedure-drafts"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-tertiary hover:text-ink-primary"
        >
          <ArrowLeft size={12} /> Back to drafts
        </Link>
      </div>
      <PageHeader
        title="Start a new AI procedure draft"
        description={
          <span className="inline-flex items-center gap-2 text-xs">
            <Clapperboard size={14} /> Record a walkthrough video or import an existing Word/PDF procedure; the AI proposes a structured procedure (steps, callouts, figures, voiceover) for your review.
          </span>
        }
      />
      <ErrorBanner error={pageError} />

      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <main className="flex flex-col gap-4">
          <Field
            label="Source"
            hint="Record a walkthrough video, or import an existing Word/PDF procedure and let the AI restructure it into steps with figures."
          >
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                active={sourceMode === 'video'}
                disabled={uploading}
                onClick={() => switchMode('video')}
                icon={<Clapperboard size={16} />}
                label="Walkthrough video"
                sub="MP4 / MOV / WEBM"
              />
              <ModeButton
                active={sourceMode === 'document'}
                disabled={uploading}
                onClick={() => switchMode('document')}
                icon={<FileText size={16} />}
                label="Word / PDF document"
                sub="Existing written procedure"
              />
            </div>
          </Field>
          <Field label="Title" hint="Used as the procedure's title once accepted. Keep it imperative (e.g., 'Replace the take-up belt').">
            <TextInput
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              placeholder="e.g. Replace the conveyor belt"
              disabled={uploading}
            />
          </Field>
          <Field label="Owner organization" hint="The procedure belongs to this org. Only orgs you have access to are shown.">
            <Select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              disabled={uploading}
              required
            >
              <option value="" disabled>
                Select an organization
              </option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Content pack" hint="Where the new procedure document will live.">
            <Select
              value={packId}
              onChange={(e) => setPackId(e.target.value)}
              disabled={uploading || !packs}
              required
            >
              <option value="" disabled>
                Select a content pack
              </option>
              {packsForOrg.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.assetModel.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Pack version"
            hint="Drafts are preferred for new authoring; published versions still accept additive procedure steps."
          >
            <Select
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              disabled={uploading || !packDetail}
              required
            >
              <option value="" disabled>
                Select a version
              </option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber}
                  {v.versionLabel ? ` (${v.versionLabel})` : ''} · {v.status}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={sourceMode === 'document' ? 'Procedure document' : 'Walkthrough video'}
            hint={
              sourceMode === 'document'
                ? 'Word (.docx) or PDF up to 50 MB. The AI keeps your sections, steps, callouts, and figures — you pick which procedures to generate next.'
                : 'MP4, MOV, or WEBM up to 2 GB. Aim for under 30 minutes of useful narration — long videos with idle stretches confuse the segmenter.'
            }
          >
            <Dropzone
              file={file}
              onPick={pickFile}
              onClear={() => setFile(null)}
              disabled={uploading}
              dragOver={dragOver}
              setDragOver={setDragOver}
              openPicker={() => inputRef.current?.click()}
              mode={sourceMode}
            />
            <input
              ref={inputRef}
              type="file"
              accept={
                sourceMode === 'document'
                  ? [...DOC_ACCEPTED_TYPES, ...DOC_ACCEPTED_EXTENSIONS].join(',')
                  : [...ACCEPTED_TYPES, ...ACCEPTED_EXTENSIONS].join(',')
              }
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
          </Field>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Link
              href="/procedure-drafts"
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition hover:border-line-strong hover:text-ink-primary"
              aria-disabled={uploading}
            >
              Cancel
            </Link>
            <PrimaryButton
              type="submit"
              disabled={
                uploading || !title.trim() || !ownerId || !packId || !versionId || !file
              }
            >
              {phase.kind === 'creating' ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Preparing…
                </>
              ) : phase.kind === 'uploading' ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Uploading {progressLabel}
                </>
              ) : phase.kind === 'finishing' ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Finalizing…
                </>
              ) : (
                <>
                  <Upload size={14} /> Start draft
                </>
              )}
            </PrimaryButton>
          </div>
          {phase.kind === 'uploading' && (
            <div className="rounded-md border border-line bg-surface px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-xs text-ink-secondary">
                <span>Uploading to Mux</span>
                <span className="font-mono tabular-nums">{progressLabel}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.round(phase.progress * 100)}%` }}
                />
              </div>
            </div>
          )}
        </main>

        <aside className="flex flex-col gap-3 text-xs">
          <Card title="What happens next">
            <ol className="ml-4 list-decimal space-y-1.5 text-ink-secondary">
              <li>Mux processes the upload (~30s after the file lands).</li>
              <li>
                Mux auto-generates captions — usually ready within 1–2 min of asset.ready.
                If captions stall, we fall back to OpenAI Whisper on the audio track.
              </li>
              <li>
                Claude Opus 4.7 reads the transcript + a multi-frame storyboard image
                and proposes structured steps with chosen keyframes and cleaned
                voiceover script.
              </li>
              <li>You land on the reviewer to edit titles, voiceover, ordering, then accept.</li>
              <li>
                On accept, each step's keyframe is fetched from Mux, voiceover is
                synthesized via OpenAI tts-1-hd, and the procedure document is created.
              </li>
            </ol>
          </Card>
          <Card title="Recording tips">
            <ul className="ml-4 list-disc space-y-1.5 text-ink-secondary">
              <li>Narrate each action as you do it; one action per spoken phrase.</li>
              <li>
                Speak the safety language explicitly when you invoke it
                (&ldquo;Apply LOTO before…&rdquo;).
              </li>
              <li>State numeric specs out loud (&ldquo;Torque to 24 newton-meters&rdquo;).</li>
              <li>Keep the equipment visible when describing it; AI picks frames mid-action.</li>
            </ul>
          </Card>
          <Card title="Cost">
            <ul className="space-y-1 text-ink-secondary">
              <li>Mux: ~$0.005/min of upload + storage.</li>
              <li>Whisper fallback: $0.006/min (only if captions stall).</li>
              <li>Claude Opus 4.7: ~$0.25–$1 per draft, depending on length.</li>
              <li>OpenAI tts-1-hd (on accept): ~$0.024 per step.</li>
            </ul>
          </Card>
        </aside>
      </form>
    </PageShell>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-raised">
      <p className="border-b border-line-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
        {title}
      </p>
      <div className="px-3 py-2 text-[11px] leading-relaxed">{children}</div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  icon,
  label,
  sub,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={[
        'flex flex-col items-start gap-1 rounded-md border px-3 py-2.5 text-left transition',
        active
          ? 'border-accent bg-accent/5 text-ink-primary'
          : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
        disabled ? 'pointer-events-none opacity-50' : '',
      ].join(' ')}
    >
      <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${active ? 'text-accent' : ''}`}>
        {icon} {label}
      </span>
      <span className="text-[10px] text-ink-tertiary">{sub}</span>
    </button>
  );
}

function Dropzone({
  file,
  onPick,
  onClear,
  disabled,
  dragOver,
  setDragOver,
  openPicker,
  mode,
}: {
  file: File | null;
  onPick: (f: File) => void;
  onClear: () => void;
  disabled: boolean;
  dragOver: boolean;
  setDragOver: (b: boolean) => void;
  openPicker: () => void;
  mode: SourceMode;
}) {
  if (file) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-line bg-surface-raised px-3 py-3">
        {mode === 'document' ? (
          <FileText size={16} className="mt-0.5 shrink-0 text-accent" />
        ) : (
          <Play size={16} className="mt-0.5 shrink-0 text-accent" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-primary">
            {file.name}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-tertiary">
            {formatBytes(file.size)} · {file.type || 'video'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="rounded p-1 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault disabled:opacity-30"
          aria-label="Remove file"
        >
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={openPicker}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        const f = e.dataTransfer.files?.[0];
        if (f) onPick(f);
      }}
      disabled={disabled}
      className={[
        'flex w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-sm font-medium transition',
        dragOver
          ? 'border-accent bg-accent/5 text-accent'
          : 'border-line bg-surface text-ink-secondary hover:border-accent/40 hover:bg-accent/5 hover:text-accent',
        disabled ? 'pointer-events-none opacity-50' : '',
      ].join(' ')}
    >
      <FileUp size={28} strokeWidth={1.5} />
      <span>
        {mode === 'document'
          ? 'Drop a Word or PDF here, or click to browse'
          : 'Drop a video here, or click to browse'}
      </span>
      <span className="text-[10px] text-ink-tertiary">
        {mode === 'document' ? '.docx / .pdf up to 50 MB' : 'MP4 / MOV / WEBM up to 2 GB'}
      </span>
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
