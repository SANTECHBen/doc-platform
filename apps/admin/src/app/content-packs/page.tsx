'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FileStack, Plus } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  Select,
  TextInput,
} from '@/components/form';
import {
  createContentPack,
  listAdminAssetModels,
  listContentPacks,
  type AdminAssetModel,
  type AdminContentPack,
} from '@/lib/api';

const LAYER_TONE = {
  base: 'info',
  dealer_overlay: 'warning',
  site_overlay: 'default',
} as const;

const STATUS_TONE = {
  draft: 'default',
  in_review: 'warning',
  published: 'success',
  archived: 'default',
} as const;

export default function ContentPacksPage() {
  const [rows, setRows] = useState<AdminContentPack[] | null>(null);
  const [models, setModels] = useState<AdminAssetModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function refresh() {
    try {
      const [packs, mm] = await Promise.all([listContentPacks(), listAdminAssetModels()]);
      setRows(packs);
      setModels(mm);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <PageShell crumbs={[{ label: 'Content packs' }]}>
      <PageHeader
        title="Content packs"
        description="Versioned bundles of documents, training modules, and parts. OEM-authored base packs can be overlaid by dealers for site-specific variations."
        actions={
          <PrimaryButton onClick={() => setOpen(true)} disabled={models.length === 0}>
            <Plus size={14} strokeWidth={2} /> New content pack
          </PrimaryButton>
        }
      />
      <ErrorBanner error={error} />
      {rows === null ? (
        <TableSkeleton cols={6} rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileStack}
          title="No content packs yet"
          description="A content pack is the versioned bundle of documents, training, and parts for one asset model. Pick a model to start authoring."
          action={
            models.length > 0 ? (
              <PrimaryButton onClick={() => setOpen(true)}>
                <Plus size={14} strokeWidth={2} /> Create a pack
              </PrimaryButton>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Layer</th>
                <th className="px-4 py-2">Asset model</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Versions</th>
                <th className="px-4 py-2">Latest</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-line-subtle align-top">
                  <td className="px-4 py-3">
                    <Link
                      href={`/content-packs/${p.id}`}
                      className="font-medium text-ink-primary hover:text-brand"
                    >
                      {p.name}
                    </Link>
                    <span className="block font-mono text-xs text-ink-tertiary">{p.slug}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone={LAYER_TONE[p.layerType]}>
                      {p.layerType.replace('_', ' ')}
                    </Pill>
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">{p.assetModel.displayName}</td>
                  <td className="px-4 py-3 text-ink-secondary">{p.owner}</td>
                  <td className="px-4 py-3">{p.versionCount}</td>
                  <td className="px-4 py-3">
                    {p.latestVersion ? (
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">
                          v{p.latestVersion.label ?? p.latestVersion.number}
                        </span>
                        <Pill
                          tone={
                            STATUS_TONE[
                              p.latestVersion.status as keyof typeof STATUS_TONE
                            ] ?? 'default'
                          }
                        >
                          {p.latestVersion.status}
                        </Pill>
                      </div>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer title="New content pack" open={open} onClose={() => setOpen(false)}>
        <NewPackForm
          models={models}
          onCreated={async () => {
            setOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function NewPackForm({
  models,
  onCreated,
}: {
  models: AdminAssetModel[];
  onCreated: () => Promise<void>;
}) {
  const [assetModelId, setAssetModelId] = useState(models[0]?.id ?? '');
  const [layerType, setLayerType] =
    useState<'base' | 'dealer_overlay' | 'site_overlay'>('base');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const selectedModel = models.find((m) => m.id === assetModelId);

  // Auto-fill name from asset model + layer until the user edits either field.
  // The slug follows from the name unless the user has edited it directly.
  useEffect(() => {
    if (nameEdited || !selectedModel) return;
    const suffix =
      layerType === 'base'
        ? ''
        : layerType === 'dealer_overlay'
        ? ' — Dealer overlay'
        : ' — Site overlay';
    const nextName = `${selectedModel.displayName}${suffix}`;
    setName(nextName);
    if (!slugEdited) setSlug(autoSlug(nextName));
  }, [assetModelId, layerType, selectedModel, nameEdited, slugEdited]);

  function autoSlug(s: string): string {
    return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function onNameChange(next: string) {
    setName(next);
    setNameEdited(true);
    if (!slugEdited) setSlug(autoSlug(next));
  }

  function onSlugChange(next: string) {
    setSlug(next);
    setSlugEdited(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createContentPack({
        assetModelId,
        name: name.trim(),
        slug: slug.trim(),
        layerType,
      });
      toast.success(`${name.trim()} created`, 'Draft v1.0.0 is ready for authoring.');
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
      <Field label="Asset model" required>
        <Select
          value={assetModelId}
          onChange={(e) => setAssetModelId(e.target.value)}
          required
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} · {m.modelCode} ({m.owner.name})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Pack name" required>
        <TextInput
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Flow Turn 90° Merge — Base"
          required
        />
      </Field>
      <Field label="Slug" required>
        <TextInput
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          placeholder="flow-turn-merge-90-base"
          pattern="[a-z0-9-]+"
          required
        />
      </Field>
      <Field label="Layer" required>
        <Select
          value={layerType}
          onChange={(e) => setLayerType(e.target.value as typeof layerType)}
        >
          <option value="base">Base (OEM)</option>
          <option value="dealer_overlay">Dealer overlay</option>
          <option value="site_overlay">Site overlay</option>
        </Select>
      </Field>
      <p className="rounded border border-line-subtle bg-surface-inset p-3 text-xs text-ink-secondary">
        A draft v1.0.0 will be created alongside the pack. Add documents to the draft,
        then publish when ready.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create content pack'}
        </PrimaryButton>
      </div>
    </form>
  );
}
