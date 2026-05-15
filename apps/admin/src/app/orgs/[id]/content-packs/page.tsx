'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { FileStack, Plus } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader, Pill } from '@/components/page-shell';
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
  listOrganizations,
  type AdminAssetModel,
  type AdminContentPack,
  type AdminOrganization,
} from '@/lib/api';

const LAYER_LABEL: Record<AdminContentPack['layerType'], string> = {
  base: 'Base',
  dealer_overlay: 'Dealer overlay',
  site_overlay: 'Site overlay',
};

export default function OrgContentPacksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [allPacks, setAllPacks] = useState<AdminContentPack[] | null>(null);
  const [models, setModels] = useState<AdminAssetModel[]>([]);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [packs, m, orgs] = await Promise.all([
        listContentPacks(),
        listAdminAssetModels(),
        listOrganizations(),
      ]);
      setAllPacks(packs);
      setModels(m);
      setOrg(orgs.find((o) => o.id === orgId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const owned = useMemo(
    () => (allPacks ?? []).filter((p) => p.owner === orgId),
    [allPacks, orgId],
  );

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Content packs' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Content packs"
          description="Bundles of documents, training, and procedures attached to an asset model. Until a version is published, scanned QR codes show empty asset hubs."
          actions={
            models.filter((m) => m.owner.id === orgId).length > 0 ? (
              <PrimaryButton onClick={() => setDrawerOpen(true)}>
                <Plus size={14} strokeWidth={2} /> New content pack
              </PrimaryButton>
            ) : null
          }
        />
        <ErrorBanner error={error} />
        {allPacks === null ? (
          <TableSkeleton cols={5} rows={5} />
        ) : owned.length === 0 ? (
          <EmptyState
            icon={FileStack}
            title="No content packs yet"
            description="Add a content pack against an asset model. You'll then add documents and procedures to its draft version, then publish."
            action={
              models.filter((m) => m.owner.id === orgId).length > 0 ? (
                <PrimaryButton onClick={() => setDrawerOpen(true)}>
                  <Plus size={14} strokeWidth={2} /> Create the first pack
                </PrimaryButton>
              ) : (
                <Link
                  href={`/orgs/${orgId}/asset-models`}
                  className="btn btn-secondary"
                >
                  Create an asset model first
                </Link>
              )
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
                  <th className="px-4 py-2">Versions</th>
                  <th className="px-4 py-2">Latest published</th>
                </tr>
              </thead>
              <tbody>
                {owned.map((p) => (
                  <tr key={p.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3">
                      <Link
                        href={`/orgs/${orgId}/content-packs/${p.id}`}
                        className="block font-medium text-ink-primary hover:text-brand"
                      >
                        {p.name}
                      </Link>
                      <span className="block font-mono text-xs text-ink-tertiary">
                        {p.slug}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={p.layerType === 'base' ? 'info' : 'default'}>
                        {LAYER_LABEL[p.layerType]}
                      </Pill>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {p.assetModel?.displayName ?? '—'}
                    </td>
                    <td className="px-4 py-3 tnum">{p.versionCount}</td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {p.latestVersion
                        ? `v${p.latestVersion.number}${
                            p.latestVersion.label
                              ? ` · ${p.latestVersion.label}`
                              : ''
                          } · ${p.latestVersion.status}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Drawer
          title="New content pack"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        >
          <NewPackForm
            orgId={orgId}
            ownedModels={models.filter((m) => m.owner.id === orgId)}
            existingPacks={allPacks ?? []}
            onCreated={async () => {
              setDrawerOpen(false);
              await refresh();
            }}
          />
        </Drawer>
      </div>
    </>
  );
}

function NewPackForm({
  orgId,
  ownedModels,
  existingPacks,
  onCreated,
}: {
  orgId: string;
  ownedModels: AdminAssetModel[];
  existingPacks: AdminContentPack[];
  onCreated: () => Promise<void>;
}) {
  const [assetModelId, setAssetModelId] = useState(ownedModels[0]?.id ?? '');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [layerType, setLayerType] =
    useState<AdminContentPack['layerType']>('base');
  const [basePackId, setBasePackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const eligibleBasePacks = existingPacks.filter(
    (p) => p.assetModel.id === assetModelId && p.layerType === 'base',
  );

  function onNameChange(next: string) {
    setName(next);
    if (!slugEdited)
      setSlug(
        next
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
      );
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
        basePackId: layerType !== 'base' ? basePackId || undefined : undefined,
      });
      toast.success(`${name.trim()} created`, 'Draft v1 ready to author.');
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
          <option value="">Select model…</option>
          {ownedModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} ({m.modelCode})
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Name" required>
        <TextInput
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Operator manual"
          required
        />
      </Field>
      <Field
        label="Slug"
        required
        hint="URL-safe identifier within this asset model."
      >
        <TextInput
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
          placeholder="operator-manual"
          pattern="[a-z0-9\-]+"
          required
        />
      </Field>
      <Field
        label="Layer type"
        required
        hint="Base packs come from the OEM; overlays from dealers/integrators add commissioning notes on top."
      >
        <Select
          value={layerType}
          onChange={(e) =>
            setLayerType(e.target.value as AdminContentPack['layerType'])
          }
          required
        >
          <option value="base">Base (OEM-owned)</option>
          <option value="dealer_overlay">Dealer overlay</option>
          <option value="site_overlay">Site overlay</option>
        </Select>
      </Field>
      {layerType !== 'base' && (
        <Field
          label="Base pack to layer on"
          required
          hint="Pick the underlying base pack this overlay extends."
        >
          <Select
            value={basePackId}
            onChange={(e) => setBasePackId(e.target.value)}
            required
          >
            <option value="">Select base pack…</option>
            {eligibleBasePacks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="mt-2 flex justify-end">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create content pack'}
        </PrimaryButton>
      </div>
    </form>
  );
}
