'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/page-shell';
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
  bulkCreateAssetInstances,
  createAssetInstance,
  pinLatestVersion,
  unpinInstance,
  listAllSites,
  listAdminAssetModels,
  listInstancesForModel,
  type AdminAssetModel,
  type AdminSite,
  type ModelInstance,
} from '@/lib/api';

export default function AssetModelDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [model, setModel] = useState<AdminAssetModel | null>(null);
  const [instances, setInstances] = useState<ModelInstance[] | null>(null);
  const [sites, setSites] = useState<AdminSite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      const [models, inst, allSites] = await Promise.all([
        listAdminAssetModels(),
        listInstancesForModel(id),
        listAllSites(),
      ]);
      const found = models.find((m) => m.id === id) ?? null;
      setModel(found);
      setInstances(inst);
      setSites(allSites);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <ErrorBanner error={error} />;
  if (!model) return <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>;

  return (
    <PageShell
      crumbs={[
        { label: 'Asset models', href: '/asset-models' },
        { label: model.displayName },
      ]}
    >
      <PageHeader
        title={model.displayName}
        description={`${model.modelCode} · ${model.category} · ${model.owner.name}`}
        actions={
          <>
            <SecondaryButton
              onClick={() => setBulkOpen(true)}
              disabled={sites.length === 0}
            >
              Bulk import
            </SecondaryButton>
            <PrimaryButton
              onClick={() => setNewOpen(true)}
              disabled={sites.length === 0}
            >
              Add instance
            </PrimaryButton>
          </>
        }
      />
      {sites.length === 0 && (
        <p className="mb-4 rounded border border-signal-warn/40 bg-signal-warn/10 p-3 text-sm text-signal-warn">
          Create at least one site before adding instances.
        </p>
      )}

      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        Deployed instances ({instances?.length ?? 0})
      </h2>

      {instances === null ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
          No instances deployed yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2">Serial</th>
                <th className="px-4 py-2">Site</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Pinned version</th>
                <th className="px-4 py-2">Installed</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.id} className="border-t border-line-subtle">
                  <td className="px-4 py-3 font-mono text-xs">{i.serialNumber}</td>
                  <td className="px-4 py-3 text-ink-secondary">{i.site.name}</td>
                  <td className="px-4 py-3 text-ink-secondary">{i.site.organization}</td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {i.pinnedVersion
                      ? `v${i.pinnedVersion.label ?? i.pinnedVersion.number}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">
                    {i.installedAt
                      ? new Date(i.installedAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={async () => {
                          try {
                            await pinLatestVersion(i.id);
                            toast.success('Latest published version pinned.');
                            await refresh();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        Pin latest
                      </button>
                      {i.pinnedVersion && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={async () => {
                            if (!confirm('Unpin this version from the instance?')) return;
                            try {
                              await unpinInstance(i.id);
                              toast.success('Unpinned.');
                              await refresh();
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : String(e));
                            }
                          }}
                        >
                          Unpin
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer title="Add instance" open={newOpen} onClose={() => setNewOpen(false)}>
        <NewInstanceForm
          assetModelId={id}
          sites={sites}
          onCreated={async () => {
            setNewOpen(false);
            await refresh();
          }}
        />
      </Drawer>

      <Drawer
        title="Bulk import serial numbers"
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
      >
        <BulkImportForm
          assetModelId={id}
          sites={sites}
          onImported={async () => {
            setBulkOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function NewInstanceForm({
  assetModelId,
  sites,
  onCreated,
}: {
  assetModelId: string;
  sites: AdminSite[];
  onCreated: () => Promise<void>;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [serialNumber, setSerialNumber] = useState('');
  const [installedAt, setInstalledAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAssetInstance({
        assetModelId,
        siteId,
        serialNumber: serialNumber.trim(),
        installedAt: installedAt ? new Date(installedAt).toISOString() : undefined,
      });
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
      <Field label="Site" required>
        <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} required>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.organizationName} · {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Serial number" required>
        <TextInput
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
          placeholder="FT-MERGE-90-00042"
          required
        />
      </Field>
      <Field label="Installed at">
        <TextInput
          type="date"
          value={installedAt}
          onChange={(e) => setInstalledAt(e.target.value)}
        />
      </Field>
      <p className="rounded border border-line-subtle bg-surface-inset p-3 text-xs text-ink-secondary">
        The instance will auto-pin to the latest published base ContentPack for this model,
        if one exists.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create instance'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function BulkImportForm({
  assetModelId,
  sites,
  onImported,
}: {
  assetModelId: string;
  sites: AdminSite[];
  onImported: () => Promise<void>;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [installedAt, setInstalledAt] = useState('');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    attempted: number;
    created: number;
    skipped: number;
  } | null>(null);

  function parseSerials(src: string): string[] {
    // Accepts line-separated or CSV-style (one per line; commas allowed).
    return src
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const serials = parseSerials(raw);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (serials.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await bulkCreateAssetInstances({
        assetModelId,
        siteId,
        serialNumbers: serials,
        installedAt: installedAt ? new Date(installedAt).toISOString() : undefined,
      });
      setResult({ attempted: res.attempted, created: res.created, skipped: res.skipped });
      if (res.created > 0) await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Site for all serials" required>
        <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} required>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.organizationName} · {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Installed at">
        <TextInput
          type="date"
          value={installedAt}
          onChange={(e) => setInstalledAt(e.target.value)}
        />
      </Field>
      <Field
        label="Serial numbers"
        required
        hint="One per line, or comma-separated. Up to 2000."
      >
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={10}
          placeholder={`FT-MERGE-90-00042\nFT-MERGE-90-00043\nFT-MERGE-90-00044`}
          required
        />
      </Field>
      <p className="text-xs text-ink-tertiary">
        Parsed: {serials.length} serial{serials.length === 1 ? '' : 's'}. Duplicates and
        serials already in the DB are skipped without erroring.
      </p>
      {result && (
        <div className="rounded border border-signal-ok/30 bg-signal-ok/10 p-3 text-sm text-signal-ok">
          Imported {result.created} of {result.attempted}. {result.skipped} skipped
          (already existed).
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting || serials.length === 0}>
          {submitting ? 'Importing…' : `Import ${serials.length || ''}`}
        </PrimaryButton>
      </div>
    </form>
  );
}
