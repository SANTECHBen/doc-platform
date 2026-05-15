'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { Boxes, Plus } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader } from '@/components/page-shell';
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
  listAdminAssetModels,
  listOrganizations,
  type AdminAssetModel,
  type AdminOrganization,
} from '@/lib/api';

const COMMON_EQUIPMENT_TYPES = [
  'Bulk Bag',
  'Cargo Scale',
  'Control Panel',
  'Curve Conveyor',
  'Diverter',
  'Field Device',
  'Inline Scale',
  'Metering Conveyor',
  'Non-Con',
  'Other',
  'Recirculation',
  'Scanner',
  'Singulator',
  'Sorter',
  'Splitter',
  'Transport Conveyor',
];

export default function OrgAssetModelsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [allModels, setAllModels] = useState<AdminAssetModel[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [models, orgs] = await Promise.all([
        listAdminAssetModels(),
        listOrganizations(),
      ]);
      setAllModels(models);
      setOrg(orgs.find((o) => o.id === orgId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Asset models owned by this org. The API returns every model the user
  // can see (across orgs in scope); we filter to what THIS workspace
  // is responsible for.
  const ownedModels = useMemo(
    () => (allModels ?? []).filter((m) => m.owner.id === orgId),
    [allModels, orgId],
  );

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Asset models' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Asset models"
          description="Equipment SKUs owned by this organization. Content is authored once per model; instances at customer sites resolve their own pinned version."
          actions={
            <PrimaryButton onClick={() => setDrawerOpen(true)}>
              <Plus size={14} strokeWidth={2} /> New asset model
            </PrimaryButton>
          }
        />
        <ErrorBanner error={error} />
        {allModels === null ? (
          <TableSkeleton cols={4} rows={5} />
        ) : ownedModels.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No asset models yet"
            description={
              org?.type === 'oem'
                ? 'OEMs author asset models. Define a SKU here so dealers and end-customers can deploy instances of it.'
                : 'No asset models owned by this org. Most non-OEM tenants reference models owned by an upstream OEM. Add one only if this org owns its own SKU.'
            }
            action={
              <PrimaryButton onClick={() => setDrawerOpen(true)}>
                <Plus size={14} strokeWidth={2} /> Create the first model
              </PrimaryButton>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2">Category</th>
                  <th className="px-4 py-2">Instances</th>
                  <th className="px-4 py-2">Content packs</th>
                </tr>
              </thead>
              <tbody>
                {ownedModels.map((m) => (
                  <tr key={m.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3">
                      <Link
                        href={`/orgs/${orgId}/asset-models/${m.id}`}
                        className="block font-medium text-ink-primary hover:text-brand"
                      >
                        {m.displayName}
                      </Link>
                      <span className="block font-mono text-xs text-ink-tertiary">
                        {m.modelCode}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">{m.category}</td>
                    <td className="px-4 py-3 tnum">{m.instanceCount}</td>
                    <td className="px-4 py-3 tnum">{m.packCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Drawer
          title="New asset model"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        >
          <NewAssetModelForm
            ownerOrganizationId={orgId}
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

function NewAssetModelForm({
  ownerOrganizationId,
  onCreated,
}: {
  ownerOrganizationId: string;
  onCreated: () => Promise<void>;
}) {
  const [modelCode, setModelCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAssetModel({
        ownerOrganizationId,
        modelCode: modelCode.trim(),
        displayName: displayName.trim(),
        category: category.trim(),
        description: description.trim() || undefined,
      });
      toast.success(`${displayName.trim()} created`, 'Asset model is ready.');
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
      <Field
        label="Model code"
        required
        hint="OEM's internal model identifier. Shown to techs alongside the display name."
      >
        <TextInput
          value={modelCode}
          onChange={(e) => setModelCode(e.target.value)}
          placeholder="FT-CV-200"
          required
        />
      </Field>
      <Field label="Display name" required>
        <TextInput
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="200-series Curve Conveyor"
          required
        />
      </Field>
      <Field
        label="Category"
        required
        hint="Equipment type. Pick from the suggestions or type your own."
      >
        <TextInput
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Curve Conveyor"
          list="equipment-types"
          required
        />
        <datalist id="equipment-types">
          {COMMON_EQUIPMENT_TYPES.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Short overview of this SKU…"
        />
      </Field>
      <div className="mt-2 flex justify-end">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Create asset model'}
        </PrimaryButton>
      </div>
    </form>
  );
}
