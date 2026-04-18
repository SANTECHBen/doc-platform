'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Boxes, ImagePlus, Plus, X } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  Select,
  TextInput,
  Textarea,
} from '@/components/form';
import {
  createAssetModel,
  uploadFile,
  listAdminAssetModels,
  listOrganizations,
  type AdminAssetModel,
  type AdminOrganization,
} from '@/lib/api';

// Broad MHE/IA equipment families — the seed uses 'asrs'. These are suggested
// values; the field accepts any lowercase string.
const COMMON_CATEGORIES = [
  'conveyor',
  'sortation',
  'asrs',
  'agv',
  'amr',
  'palletizer',
  'robotic_cell',
  'lift',
  'packing',
  'other',
];

export default function AssetModelsPage() {
  const [rows, setRows] = useState<AdminAssetModel[] | null>(null);
  const [oems, setOems] = useState<AdminOrganization[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [models, orgs] = await Promise.all([listAdminAssetModels(), listOrganizations()]);
      setRows(models);
      setOems(orgs.filter((o) => o.type === 'oem'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <PageShell crumbs={[{ label: 'Asset models' }]}>
      <PageHeader
        title="Asset models"
        description="Equipment SKUs. Content is authored once per model; instances at customer sites resolve their own pinned version."
        actions={
          <PrimaryButton onClick={() => setDrawerOpen(true)} disabled={oems.length === 0}>
            <Plus size={14} strokeWidth={2} /> New asset model
          </PrimaryButton>
        }
      />
      <ErrorBanner error={error} />
      {oems.length === 0 && (
        <p className="mb-4 rounded border border-signal-warn/40 bg-signal-warn/10 p-3 text-sm text-signal-warn">
          Create an OEM organization first — asset models must be owned by one.
        </p>
      )}
      {rows === null ? (
        <TableSkeleton cols={5} rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No asset models yet"
          description="An asset model is an equipment SKU (e.g. FT-MERGE-90). Content is authored once per model; every instance at a customer site resolves its own pinned version."
          action={
            oems.length > 0 ? (
              <PrimaryButton onClick={() => setDrawerOpen(true)}>
                <Plus size={14} strokeWidth={2} /> Add the first model
              </PrimaryButton>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2" style={{ width: 80 }}></th>
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2">OEM</th>
                <th className="px-4 py-2">Instances</th>
                <th className="px-4 py-2">Content packs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-line-subtle align-top">
                  <td className="px-4 py-3" style={{ width: 80 }}>
                    {m.imageUrl ? (
                      <img
                        src={m.imageUrl}
                        alt=""
                        className="h-14 w-14 rounded object-cover"
                        style={{ border: '1px solid rgb(var(--line))' }}
                      />
                    ) : (
                      <div
                        className="flex h-14 w-14 items-center justify-center rounded text-ink-tertiary"
                        style={{
                          background: 'rgb(var(--surface-inset))',
                          border: '1px solid rgb(var(--line-subtle))',
                        }}
                      >
                        <Boxes size={20} strokeWidth={1.5} />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/asset-models/${m.id}`}
                      className="block font-medium text-ink-primary hover:text-brand"
                    >
                      {m.displayName}
                    </Link>
                    <span className="block font-mono text-xs text-ink-tertiary">{m.modelCode}</span>
                    {m.description && (
                      <span className="mt-1 block text-xs text-ink-tertiary">{m.description}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 uppercase tracking-wide text-ink-secondary">
                    {m.category}
                  </td>
                  <td className="px-4 py-3">{m.owner.name}</td>
                  <td className="px-4 py-3">{m.instanceCount}</td>
                  <td className="px-4 py-3">{m.packCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer title="New asset model" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <NewAssetModelForm
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

function NewAssetModelForm({
  oems,
  onCreated,
}: {
  oems: AdminOrganization[];
  onCreated: () => Promise<void>;
}) {
  const [ownerOrganizationId, setOwner] = useState(oems[0]?.id ?? '');
  const [modelCode, setModelCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('conveyor');
  const [description, setDescription] = useState('');
  const [imageStorageKey, setImageStorageKey] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function onImagePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
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
      await createAssetModel({
        ownerOrganizationId,
        modelCode: modelCode.trim(),
        displayName: displayName.trim(),
        category: category.trim().toLowerCase(),
        description: description.trim() || undefined,
        imageStorageKey: imageStorageKey ?? undefined,
      });
      toast.success(`${displayName.trim()} created`, `Model code ${modelCode.trim()}`);
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
        <Select value={ownerOrganizationId} onChange={(e) => setOwner(e.target.value)} required>
          {oems.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Model code"
        required
        hint="OEM's own model identifier. e.g. FT-MERGE-90, MS-4."
      >
        <TextInput
          value={modelCode}
          onChange={(e) => setModelCode(e.target.value)}
          placeholder="FT-MERGE-90"
          required
        />
      </Field>
      <Field label="Display name" required>
        <TextInput
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Flow Turn 90° Merge"
          required
        />
      </Field>
      <Field label="Category" required hint="Broad equipment family.">
        <input
          list="cat-options"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded border border-line bg-surface-raised px-2 py-1.5"
          required
        />
        <datalist id="cat-options">
          {COMMON_CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="High-throughput zero-pressure merge for case conveyor lines."
          rows={3}
        />
      </Field>

      <Field
        label="Hero photo"
        hint="Displayed on the PWA asset hub. One photo represents the model SKU."
      >
        {imagePreview ? (
          <div className="flex items-center gap-3">
            <img
              src={imagePreview}
              alt="Hero preview"
              className="h-24 w-32 rounded border border-line object-cover"
            />
            <button
              type="button"
              onClick={() => {
                setImageStorageKey(null);
                setImagePreview(null);
              }}
              className="inline-flex items-center gap-1 text-xs text-signal-fault hover:underline"
            >
              <X size={12} /> Remove
            </button>
          </div>
        ) : (
          <label
            className={`flex cursor-pointer items-center gap-2 rounded border border-dashed border-line bg-surface-inset px-3 py-4 text-sm text-ink-secondary transition hover:border-line-strong hover:text-ink-primary ${
              uploading ? 'opacity-50' : ''
            }`}
          >
            <ImagePlus size={16} strokeWidth={1.75} />
            {uploading ? 'Uploading…' : 'Click to upload a hero photo (JPG / PNG)'}
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
          {submitting ? 'Creating…' : 'Create asset model'}
        </PrimaryButton>
      </div>
    </form>
  );
}
