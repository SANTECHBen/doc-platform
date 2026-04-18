'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { FilePlus2, GraduationCap, Plus, Send } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
  Textarea,
} from '@/components/form';
import {
  createContentPackVersion,
  createDocument,
  createTrainingModule,
  deleteDocument,
  getContentPack,
  publishContentPackVersion,
  uploadFile,
  type AdminContentPackDetail,
  type CreateDocumentInput,
  type DocumentKind,
  type UploadResult,
} from '@/lib/api';

const STATUS_TONE = {
  draft: 'default',
  in_review: 'warning',
  published: 'success',
  archived: 'default',
} as const;

export default function ContentPackDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [pack, setPack] = useState<AdminContentPackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState<string | null>(null);
  const [moduleOpen, setModuleOpen] = useState<string | null>(null);
  const toast = useToast();

  async function refresh() {
    try {
      setPack(await getContentPack(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onNewVersion() {
    setBusy(true);
    setError(null);
    try {
      await createContentPackVersion(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPublish(versionId: string) {
    if (!confirm('Publish this version? It becomes immutable.')) return;
    setBusy(true);
    setError(null);
    try {
      await publishContentPackVersion(versionId);
      toast.success('Version published', 'Content is now immutable and available to instances.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteDoc(docId: string) {
    if (!confirm('Remove this document from the draft?')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDocument(docId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !pack) return <ErrorBanner error={error} />;
  if (!pack) return <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>;

  const hasDraft = pack.versions.some((v) => v.status === 'draft');

  return (
    <PageShell
      crumbs={[
        { label: 'Content packs', href: '/content-packs' },
        { label: pack.name },
      ]}
    >
      <PageHeader
        title={pack.name}
        description={`${pack.layerType.replace('_', ' ')} pack for ${pack.assetModel.displayName} (${pack.assetModel.modelCode})`}
        actions={
          !hasDraft && (
            <PrimaryButton onClick={onNewVersion} disabled={busy}>
              <Plus size={14} strokeWidth={2} /> New draft version
            </PrimaryButton>
          )
        }
      />
      <ErrorBanner error={error} />

      <div className="flex flex-col gap-4">
        {pack.versions.map((v) => (
          <section key={v.id} className="rounded-md border border-line-subtle bg-surface-raised p-4">
            <header className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">
                  v{v.versionLabel ?? v.versionNumber}
                </span>
                <Pill tone={STATUS_TONE[v.status as keyof typeof STATUS_TONE] ?? 'default'}>
                  {v.status}
                </Pill>
                {v.publishedAt && (
                  <span className="text-xs text-ink-tertiary">
                    Published {new Date(v.publishedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              {v.status === 'draft' && (
                <div className="flex items-center gap-2">
                  <SecondaryButton onClick={() => setModuleOpen(v.id)} disabled={busy}>
                    <GraduationCap size={14} strokeWidth={2} /> Add module
                  </SecondaryButton>
                  <SecondaryButton onClick={() => setAddOpen(v.id)} disabled={busy}>
                    <FilePlus2 size={14} strokeWidth={2} /> Add document
                  </SecondaryButton>
                  <PrimaryButton
                    onClick={() => onPublish(v.id)}
                    disabled={busy || v.documents.length === 0}
                  >
                    <Send size={14} strokeWidth={2} /> Publish
                  </PrimaryButton>
                </div>
              )}
            </header>
            {v.changelog && (
              <p className="mt-2 text-sm text-ink-secondary">{v.changelog}</p>
            )}

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Documents ({v.documents.length})
                </p>
                {v.documents.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-tertiary">
                    {v.status === 'draft' ? 'None yet. Add one to publish.' : 'None.'}
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1.5 text-sm">
                    {v.documents.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-start gap-2 rounded border border-line-subtle bg-surface-inset px-2 py-1.5"
                      >
                        <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-tertiary">
                          {d.kind}
                        </span>
                        <span className="flex-1">
                          <span className="block text-ink-primary">{d.title}</span>
                          <span className="text-xs text-ink-tertiary">{d.language}</span>
                        </span>
                        {d.safetyCritical && <Pill tone="warning">safety</Pill>}
                        {v.status === 'draft' && (
                          <button
                            onClick={() => onDeleteDoc(d.id)}
                            className="text-xs text-signal-fault hover:underline"
                            disabled={busy}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Training modules ({v.trainingModules.length})
                </p>
                {v.trainingModules.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-tertiary">None.</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1 text-sm">
                    {v.trainingModules.map((m) => (
                      <li key={m.id} className="text-ink-primary">
                        {m.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>

      <Drawer
        title="Add document"
        open={addOpen !== null}
        onClose={() => setAddOpen(null)}
      >
        {addOpen && (
          <AddDocumentForm
            versionId={addOpen}
            onCreated={async () => {
              setAddOpen(null);
              await refresh();
            }}
          />
        )}
      </Drawer>

      <Drawer
        title="Add training module"
        open={moduleOpen !== null}
        onClose={() => setModuleOpen(null)}
      >
        {moduleOpen && (
          <AddModuleForm
            versionId={moduleOpen}
            onCreated={async () => {
              setModuleOpen(null);
              await refresh();
            }}
          />
        )}
      </Drawer>
    </PageShell>
  );
}

// Multi-kind document creator. The form changes shape based on the chosen kind:
//   markdown / structured_procedure  → markdown editor
//   pdf / slides / file / schematic  → file picker + upload
//   video                            → file picker OR Mux playback id
//   external_video                   → URL field (YouTube/Vimeo/Mux)
function AddDocumentForm({
  versionId,
  onCreated,
}: {
  versionId: string;
  onCreated: () => Promise<void>;
}) {
  const [kind, setKind] = useState<DocumentKind>('markdown');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('en');
  const [safetyCritical, setSafetyCritical] = useState(false);
  const [tagsRaw, setTagsRaw] = useState('');
  const [bodyMarkdown, setBodyMarkdown] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [streamPlaybackId, setStreamPlaybackId] = useState('');
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [thumbnail, setThumbnail] = useState<UploadResult | null>(null);
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsFile =
    kind === 'pdf' ||
    kind === 'slides' ||
    kind === 'file' ||
    kind === 'schematic' ||
    (kind === 'video' && !streamPlaybackId);

  const needsMarkdown = kind === 'markdown' || kind === 'structured_procedure';
  const needsExternalUrl = kind === 'external_video';

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    setUploadPct(0);
    try {
      const result = await uploadFile(file, (loaded, total) =>
        setUploadPct(total > 0 ? Math.round((loaded / total) * 100) : 0),
      );
      setUpload(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function onThumbnailPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setThumbnailUploading(true);
    try {
      const result = await uploadFile(file);
      setThumbnail(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThumbnailUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body: CreateDocumentInput = {
        kind,
        title: title.trim(),
        language,
        safetyCritical,
        tags: tagsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      };
      if (needsMarkdown) body.bodyMarkdown = bodyMarkdown;
      if (needsExternalUrl) body.externalUrl = externalUrl.trim();
      if (kind === 'video' && streamPlaybackId.trim()) {
        body.streamPlaybackId = streamPlaybackId.trim();
      }
      if (thumbnail) {
        body.thumbnailStorageKey = thumbnail.storageKey;
      }
      if (upload) {
        body.storageKey = upload.storageKey;
        body.originalFilename = upload.originalFilename;
        body.contentType = upload.contentType;
        body.sizeBytes = upload.size;
      }
      await createDocument(versionId, body);
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Kind" required>
        <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
          <optgroup label="Text">
            <option value="markdown">Markdown document</option>
            <option value="structured_procedure">Structured procedure (markdown)</option>
          </optgroup>
          <optgroup label="Uploaded files">
            <option value="pdf">PDF</option>
            <option value="slides">Slides (PowerPoint/Keynote/Google)</option>
            <option value="video">Video (self-hosted upload)</option>
            <option value="schematic">Schematic / drawing</option>
            <option value="file">Other file (Word, CAD, ZIP, …)</option>
          </optgroup>
          <optgroup label="External">
            <option value="external_video">Streaming video URL (YouTube, Vimeo, …)</option>
          </optgroup>
        </Select>
      </Field>
      <Field label="Title" required>
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Startup sequence — cold start"
          required
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Language" hint="ISO-639-1. en, es, de, fr, …">
          <TextInput
            value={language}
            onChange={(e) => setLanguage(e.target.value.toLowerCase())}
            maxLength={2}
          />
        </Field>
        <Field label="Tags" hint="Comma-separated.">
          <TextInput value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} />
        </Field>
      </div>
      <label className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm">
        <input
          type="checkbox"
          checked={safetyCritical}
          onChange={(e) => setSafetyCritical(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block font-medium text-amber-900">Safety-critical</span>
          <span className="block text-xs text-amber-800">
            Forces the AI to quote this document verbatim rather than paraphrase, and
            surfaces a warning banner in the PWA viewer.
          </span>
        </span>
      </label>

      <Field
        label="Thumbnail"
        hint="Optional. Shown as the card cover in the PWA docs grid. Falls back to a typed icon if omitted."
      >
        {thumbnail ? (
          <div className="flex items-center gap-3">
            <img
              src={thumbnail.url}
              alt=""
              className="h-16 w-24 rounded object-cover"
              style={{ border: '1px solid rgb(var(--line))' }}
            />
            <button
              type="button"
              onClick={() => setThumbnail(null)}
              className="text-xs text-signal-fault hover:underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <label
            className={`flex cursor-pointer items-center gap-2 rounded border border-dashed border-line bg-surface-inset px-3 py-3 text-sm text-ink-secondary transition hover:border-line-strong hover:text-ink-primary ${
              thumbnailUploading ? 'opacity-50' : ''
            }`}
          >
            {thumbnailUploading ? 'Uploading…' : 'Upload thumbnail image'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onThumbnailPicked}
              className="hidden"
              disabled={thumbnailUploading}
            />
          </label>
        )}
      </Field>

      {needsMarkdown && (
        <Field label="Markdown body" required>
          <Textarea
            value={bodyMarkdown}
            onChange={(e) => setBodyMarkdown(e.target.value)}
            rows={12}
            className="font-mono text-xs"
            placeholder={'# Startup\n\n1. Verify alarms cleared\n2. …'}
            required
          />
        </Field>
      )}

      {needsExternalUrl && (
        <Field
          label="Video URL"
          required
          hint="YouTube, Vimeo, Wistia, Mux embed URL, etc."
        >
          <TextInput
            type="url"
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            required
          />
        </Field>
      )}

      {kind === 'video' && (
        <Field
          label="Mux / Cloudflare Stream playback ID"
          hint="Optional. If set, the PWA uses this instead of a self-hosted upload."
        >
          <TextInput
            value={streamPlaybackId}
            onChange={(e) => setStreamPlaybackId(e.target.value)}
            placeholder="Mux playback ID"
          />
        </Field>
      )}

      {needsFile && (
        <Field
          label={`Upload ${kind === 'video' ? 'video' : kind === 'slides' ? 'slide deck' : kind === 'pdf' ? 'PDF' : 'file'}`}
          required={!upload}
        >
          <input
            type="file"
            onChange={onFilePicked}
            disabled={uploading}
            accept={acceptFor(kind)}
            className="block text-sm"
          />
          {uploading && (
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-200">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{ width: `${uploadPct}%` }}
              />
            </div>
          )}
          {upload && (
            <div className="mt-1 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
              Uploaded <span className="font-mono">{upload.originalFilename}</span> ·{' '}
              {formatBytes(upload.size)}
            </div>
          )}
        </Field>
      )}

      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton
          type="submit"
          disabled={
            submitting ||
            uploading ||
            (needsFile && !upload) ||
            (needsMarkdown && !bodyMarkdown.trim()) ||
            (needsExternalUrl && !externalUrl.trim())
          }
        >
          {submitting ? 'Adding…' : 'Add document'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function acceptFor(kind: DocumentKind): string | undefined {
  switch (kind) {
    case 'pdf':
      return 'application/pdf,.pdf';
    case 'video':
      return 'video/*';
    case 'slides':
      return '.pptx,.ppt,.key,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint';
    case 'schematic':
      return 'image/*,.pdf,.dwg,.dxf';
    default:
      return undefined;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function AddModuleForm({
  versionId,
  onCreated,
}: {
  versionId: string;
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [estimatedMinutes, setEstimatedMinutes] = useState<string>('');
  const [competencyTag, setCompetencyTag] = useState('');
  const [passThreshold, setPassThreshold] = useState<string>('80');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createTrainingModule({
        contentPackVersionId: versionId,
        title: title.trim(),
        description: description.trim() || undefined,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
        competencyTag: competencyTag.trim() || undefined,
        passThreshold: passThreshold ? Number(passThreshold) / 100 : undefined,
      });
      toast.success('Module created', `${title.trim()} is now in this draft.`);
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Title" required>
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="MS-4 Operator Basics"
          required
        />
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Pre-shift checks, startup sequence, alarm acknowledgment."
          rows={3}
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Estimated time" hint="Minutes. Optional.">
          <TextInput
            type="number"
            value={estimatedMinutes}
            onChange={(e) => setEstimatedMinutes(e.target.value)}
            placeholder="20"
            min={0}
          />
        </Field>
        <Field label="Pass threshold" hint="% to pass. Default 80.">
          <TextInput
            type="number"
            value={passThreshold}
            onChange={(e) => setPassThreshold(e.target.value)}
            placeholder="80"
            min={0}
            max={100}
          />
        </Field>
      </div>
      <Field
        label="Competency tag"
        hint="Stable identifier for this competency. e.g. mhe.operator.asrs.multishuttle.basic"
      >
        <TextInput
          value={competencyTag}
          onChange={(e) => setCompetencyTag(e.target.value)}
          placeholder="mhe.operator.conveyor.basic"
        />
      </Field>
      <p className="rounded border border-line-subtle bg-surface-inset p-3 text-xs text-ink-secondary">
        After creating the module you can add lessons and quiz activities from the
        module's page (coming next). For now, seed via script or add this module
        to an existing content pack.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create module'}
        </PrimaryButton>
      </div>
    </form>
  );
}
