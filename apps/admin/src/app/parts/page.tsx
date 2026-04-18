'use client';

import { useEffect, useState } from 'react';
import { ImagePlus, Plus, Wrench, X } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  Select,
  TextInput,
  Textarea,
} from '@/components/form';
import { useToast } from '@/components/toast';
import {
  createPart,
  listAdminParts,
  listOrganizations,
  updatePartImage,
  uploadFile,
  type AdminOrganization,
  type AdminPart,
} from '@/lib/api';

export default function PartsPage() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<AdminPart[] | null>(null);
  const [oems, setOems] = useState<AdminOrganization[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [p, orgs] = await Promise.all([listAdminParts(), listOrganizations()]);
      setRows(p);
      setOems(orgs.filter((o) => o.type === 'oem'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = rows ? filter(rows, query) : null;

  return (
    <PageShell crumbs={[{ label: 'Parts' }]}>
      <PageHeader
        title="Parts"
        description="OEM-owned catalog. Each part can belong to the BOMs of many asset models. Upload an image so technicians can identify by sight."
        actions={
          <PrimaryButton onClick={() => setDrawerOpen(true)} disabled={oems.length === 0}>
            <Plus size={14} strokeWidth={2} /> New part
          </PrimaryButton>
        }
      />
      {error && (
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'rgba(var(--signal-fault) / 0.3)',
            background: 'rgba(var(--signal-fault) / 0.1)',
            color: 'rgb(var(--signal-fault))',
          }}
        >
          {error}
        </div>
      )}
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by part #, name, cross-ref"
        className="mb-4 w-full rounded border border-line bg-surface-raised px-3 py-2 text-sm md:max-w-md"
      />
      {!filtered ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">No parts found.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2" style={{ width: 80 }}></th>
                <th className="px-4 py-2">Part #</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Cross-refs</th>
                <th className="px-4 py-2">BOMs</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <PartRow key={p.id} part={p} onRefresh={refresh} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        title="New part"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <NewPartForm
          oems={oems}
          onCreated={async () => {
            setDrawerOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function NewPartForm({
  oems,
  onCreated,
}: {
  oems: AdminOrganization[];
  onCreated: () => Promise<void>;
}) {
  const [ownerId, setOwnerId] = useState(oems[0]?.id ?? '');
  const [oemPartNumber, setOemPartNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [crossRefsRaw, setCrossRefsRaw] = useState('');
  const [imageStorageKey, setImageStorageKey] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const r = await uploadFile(file);
      setImageStorageKey(r.storageKey);
      setImagePreview(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createPart({
        ownerOrganizationId: ownerId,
        oemPartNumber: oemPartNumber.trim(),
        displayName: displayName.trim(),
        description: description.trim() || undefined,
        crossReferences: crossRefsRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        imageStorageKey: imageStorageKey ?? undefined,
      });
      toast.success('Part created', `${oemPartNumber.trim()} added to catalog.`);
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
      <Field label="OEM" required>
        <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required>
          {oems.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="OEM part number" required>
        <TextInput
          value={oemPartNumber}
          onChange={(e) => setOemPartNumber(e.target.value)}
          placeholder="DM-4712"
          required
        />
      </Field>
      <Field label="Display name" required>
        <TextInput
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Shuttle drive motor assembly"
          required
        />
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Servo drive motor with integrated encoder for MS-4 shuttle."
        />
      </Field>
      <Field label="Cross-references" hint="Comma-separated aftermarket part numbers.">
        <TextInput
          value={crossRefsRaw}
          onChange={(e) => setCrossRefsRaw(e.target.value)}
          placeholder="SEW-DFS71M4B, ABB-M3AA"
        />
      </Field>
      <Field label="Image">
        {imagePreview ? (
          <div className="flex items-center gap-3">
            <img
              src={imagePreview}
              alt=""
              className="h-16 w-16 rounded object-cover"
              style={{ border: '1px solid rgb(var(--line))' }}
            />
            <button
              type="button"
              onClick={() => {
                setImageStorageKey(null);
                setImagePreview(null);
              }}
              className="text-xs text-signal-fault hover:underline"
            >
              Remove
            </button>
          </div>
        ) : (
          <label
            className={`flex cursor-pointer items-center gap-2 rounded border border-dashed border-line bg-surface-inset px-3 py-3 text-sm text-ink-secondary transition hover:border-line-strong hover:text-ink-primary ${
              uploading ? 'opacity-50' : ''
            }`}
          >
            <ImagePlus size={14} strokeWidth={1.75} />
            {uploading ? 'Uploading…' : 'Upload part image'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onImagePicked}
              className="hidden"
              disabled={uploading}
            />
          </label>
        )}
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting || uploading}>
          {submitting ? 'Creating…' : 'Create part'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function PartRow({ part, onRefresh }: { part: AdminPart; onRefresh: () => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const toast = useToast();

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const r = await uploadFile(file);
      await updatePartImage(part.id, r.storageKey);
      toast.success('Part image updated', part.displayName);
      await onRefresh();
    } catch (err) {
      toast.error('Upload failed', err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function removeImage() {
    try {
      await updatePartImage(part.id, null);
      await onRefresh();
    } catch (err) {
      toast.error('Remove failed', err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <tr className="border-t border-line-subtle align-top">
      <td className="px-4 py-3" style={{ width: 80 }}>
        {part.imageUrl ? (
          <div className="group relative">
            <img
              src={part.imageUrl}
              alt=""
              className="h-14 w-14 rounded object-cover"
              style={{ border: '1px solid rgb(var(--line))' }}
            />
            <button
              type="button"
              onClick={removeImage}
              className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface-raised text-ink-tertiary shadow-sm transition hover:text-signal-fault"
              aria-label="Remove image"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <label
            className={`flex h-14 w-14 cursor-pointer items-center justify-center rounded border border-dashed border-line bg-surface-inset text-ink-tertiary transition hover:border-line-strong hover:text-ink-primary ${
              uploading ? 'opacity-50' : ''
            }`}
            title="Upload part image"
          >
            {uploading ? (
              <span className="text-[10px]">…</span>
            ) : (
              <ImagePlus size={18} strokeWidth={1.5} />
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onImagePicked}
              className="hidden"
              disabled={uploading}
            />
          </label>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs">{part.oemPartNumber}</td>
      <td className="px-4 py-3">
        <span className="block font-medium text-ink-primary">{part.displayName}</span>
        {part.description && (
          <span className="block text-xs text-ink-tertiary">{part.description}</span>
        )}
      </td>
      <td className="px-4 py-3 text-ink-secondary">{part.owner}</td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {part.crossReferences.length === 0 ? (
            <span className="text-xs text-ink-tertiary">—</span>
          ) : (
            part.crossReferences.map((x) => (
              <span
                key={x}
                className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-ink-secondary"
              >
                {x}
              </span>
            ))
          )}
        </div>
      </td>
      <td className="px-4 py-3">{part.bomCount}</td>
      <td className="px-4 py-3">
        {part.discontinued && <Pill tone="warning">discontinued</Pill>}
      </td>
    </tr>
  );
}

function filter(rows: AdminPart[], query: string): AdminPart[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.oemPartNumber, r.displayName, r.description, ...r.crossReferences, r.owner]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q),
  );
}
