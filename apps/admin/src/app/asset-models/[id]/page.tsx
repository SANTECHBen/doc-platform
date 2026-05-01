'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
import { Package, Plus, Trash2, Upload } from 'lucide-react';
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
  addBomEntry,
  bulkCreateAssetInstances,
  createAssetInstance,
  listAdminParts,
  listBom,
  pinLatestVersion,
  removeBomEntry,
  unpinInstance,
  listAllSites,
  listAdminAssetModels,
  listInstancesForModel,
  type AdminAssetModel,
  type AdminPart,
  type AdminSite,
  type BomEntry,
  type ModelInstance,
} from '@/lib/api';

export default function AssetModelDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const continueOrgId = searchParams?.get('continue') ?? null;
  const [model, setModel] = useState<AdminAssetModel | null>(null);
  const [instances, setInstances] = useState<ModelInstance[] | null>(null);
  const [sites, setSites] = useState<AdminSite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const toast = useToast();

  // Auto-open the Add instance drawer when arriving via the Setup status
  // "Continue: deploy an asset instance" CTA from the tenant detail.
  useEffect(() => {
    if (continueOrgId && sites.length > 0) setNewOpen(true);
  }, [continueOrgId, sites.length]);

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
        <div className="mb-4 rounded border border-signal-warn/40 bg-signal-warn/10 p-3 text-sm text-signal-warn">
          <p className="font-medium">No sites in scope yet.</p>
          <p className="mt-1 text-ink-secondary">
            An asset instance is a <strong>physical unit at a specific location</strong>{' '}
            so techs scanning its QR know which unit they're servicing. The location can
            be any of:
          </p>
          <ul className="ml-5 mt-1 list-disc text-ink-secondary">
            <li>
              <strong>The OEM's own site</strong> — factory floor, demo unit, showroom,
              pre-deployment inventory. Use this when the QR ships with the product
              before it's sold/installed.
            </li>
            <li>
              <strong>An integrator's site</strong> — staging / commissioning facility.
            </li>
            <li>
              <strong>An end-customer's site</strong> — the deployed location (e.g.,
              "FedEx Memphis Secondary 25"). Most common for live equipment.
            </li>
          </ul>
          <p className="mt-2 text-ink-secondary">
            Open <a className="underline" href={`/tenants/${model.owner.id}`}>{model.owner.name}</a>{' '}
            (or any other tenant in scope) and add a site there, then come back to
            click Add instance.
          </p>
        </div>
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

      <BomPanel assetModelId={id} />

      <Drawer title="Add instance" open={newOpen} onClose={() => setNewOpen(false)}>
        <NewInstanceForm
          assetModelId={id}
          sites={
            // When walking through tenant setup, narrow the site picker to the
            // tenant's own sites to avoid mistakenly assigning the instance to
            // a sibling org's site.
            continueOrgId
              ? sites.filter((s) => s.organizationId === continueOrgId)
              : sites
          }
          continueMode={!!continueOrgId}
          onCreated={async (continueSetup) => {
            setNewOpen(false);
            await refresh();
            if (continueSetup && continueOrgId) {
              router.push(`/tenants/${continueOrgId}?step=qr_code`);
            }
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
  continueMode,
  onCreated,
}: {
  assetModelId: string;
  sites: AdminSite[];
  continueMode: boolean;
  onCreated: (continueSetup: boolean) => Promise<void>;
}) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [serialNumber, setSerialNumber] = useState('');
  const [installedAt, setInstalledAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [continueAfter, setContinueAfter] = useState(false);

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
      await onCreated(continueAfter);
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
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {continueMode && (
          <SecondaryButton
            type="submit"
            disabled={submitting}
            onClick={() => setContinueAfter(true)}
          >
            {submitting && continueAfter ? 'Saving…' : 'Save & continue setup'}
          </SecondaryButton>
        )}
        <PrimaryButton
          type="submit"
          disabled={submitting}
          onClick={() => setContinueAfter(false)}
        >
          {submitting && !continueAfter ? 'Creating…' : continueMode ? 'Save' : 'Create instance'}
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

// Bill of materials panel. Without a BOM, parts stay in the catalog but never
// surface on an asset's Parts tab in the PWA. This is the piece that connects
// a cataloged Part to an AssetModel with position + quantity context.
function BomPanel({ assetModelId }: { assetModelId: string }) {
  const [entries, setEntries] = useState<BomEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      setEntries(await listBom(assetModelId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetModelId]);

  async function onRemove(bomEntryId: string, displayName: string) {
    if (!confirm(`Remove "${displayName}" from this model's BOM?`)) return;
    try {
      await removeBomEntry(bomEntryId);
      toast.success('Removed from BOM');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Bill of materials ({entries?.length ?? 0})
          </h2>
          <p className="text-xs text-ink-tertiary">
            Pulls from the global{' '}
            <a className="underline" href="/parts">
              parts catalog
            </a>{' '}
            — this list is which parts make up THIS model, with quantity + position.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="btn btn-secondary btn-sm"
          title="Attach an existing catalog part to this model's BOM"
        >
          <Plus size={13} strokeWidth={2} /> Add part to BOM
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </p>
      )}

      {entries === null ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
          No BOM entries. Add a part from the catalog to make it visible on this
          asset's Parts tab in the PWA.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="w-14 px-4 py-2"></th>
                <th className="px-4 py-2">Part</th>
                <th className="px-4 py-2">OEM #</th>
                <th className="w-24 px-4 py-2">Position</th>
                <th className="w-16 px-4 py-2">Qty</th>
                <th className="px-4 py-2">Notes</th>
                <th className="w-16 px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.bomEntryId} className="border-t border-line-subtle">
                  <td className="px-4 py-2">
                    {e.imageUrl ? (
                      <img
                        src={e.imageUrl}
                        alt=""
                        className="h-10 w-10 rounded object-cover"
                        style={{ border: '1px solid rgb(var(--line))' }}
                      />
                    ) : (
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded text-ink-tertiary"
                        style={{
                          background: 'rgb(var(--surface-inset))',
                          border: '1px solid rgb(var(--line-subtle))',
                        }}
                      >
                        <Package size={16} strokeWidth={1.5} />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-primary">{e.displayName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                    {e.oemPartNumber ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                    {e.positionRef ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-ink-secondary tabular-nums">
                    {e.quantity}
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">
                    {e.notes ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onRemove(e.bomEntryId, e.displayName)}
                      aria-label={`Remove ${e.displayName} from BOM`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-inset hover:text-signal-fault"
                      title="Remove from BOM"
                    >
                      <Trash2 size={14} strokeWidth={2} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer title="Add part to BOM" open={addOpen} onClose={() => setAddOpen(false)}>
        <AddBomForm
          assetModelId={assetModelId}
          existingPartIds={new Set((entries ?? []).map((e) => e.partId))}
          onAdded={async () => {
            setAddOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </section>
  );
}

function AddBomForm({
  assetModelId,
  existingPartIds,
  onAdded,
}: {
  assetModelId: string;
  existingPartIds: Set<string>;
  onAdded: () => Promise<void>;
}) {
  const [parts, setParts] = useState<AdminPart[] | null>(null);
  const [search, setSearch] = useState('');
  const [selectedPartId, setSelectedPartId] = useState<string>('');
  const [positionRef, setPositionRef] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAdminParts()
      .then((all) => setParts(all))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Filter out parts already on the BOM so users don't create duplicates by
  // accident (the DB allows them, but they're almost always an authoring
  // mistake — same part at the same position).
  const available = useMemo(() => {
    if (!parts) return null;
    const remaining = parts.filter((p) => !existingPartIds.has(p.id));
    const q = search.trim().toLowerCase();
    if (!q) return remaining;
    return remaining.filter((p) =>
      [p.oemPartNumber, p.displayName, p.description ?? '', p.owner]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [parts, existingPartIds, search]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPartId) {
      setError('Pick a part first.');
      return;
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) {
      setError('Quantity must be a positive integer.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await addBomEntry(assetModelId, {
        partId: selectedPartId,
        quantity: qty,
        positionRef: positionRef.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {error && (
        <p className="rounded border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </p>
      )}

      <Field label="Search parts">
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="OEM #, name, description, or owner"
          autoFocus
        />
      </Field>

      <div>
        <span className="form-label">Part</span>
        {available === null ? (
          <p className="mt-1.5 p-3 text-sm text-ink-tertiary">Loading parts…</p>
        ) : available.length === 0 ? (
          <p className="mt-1.5 rounded border border-dashed border-line p-3 text-sm text-ink-tertiary">
            {parts && parts.length === existingPartIds.size
              ? 'Every part in the catalog is already on this BOM.'
              : 'No parts match.'}
          </p>
        ) : (
          <ul className="mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto rounded border border-line p-1">
            {available.map((p) => (
              <li key={p.id}>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
                    selectedPartId === p.id
                      ? 'bg-brand-soft text-ink-primary'
                      : 'hover:bg-surface-elevated'
                  }`}
                >
                  <input
                    type="radio"
                    name="part"
                    value={p.id}
                    checked={selectedPartId === p.id}
                    onChange={() => setSelectedPartId(p.id)}
                    className="shrink-0"
                  />
                  <span className="font-mono text-xs text-ink-brand">
                    {p.oemPartNumber}
                  </span>
                  <span className="truncate text-ink-primary">{p.displayName}</span>
                  <span className="ml-auto shrink-0 text-xs text-ink-tertiary">
                    {p.owner}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Position" hint="Optional — e.g. A-12, Motor 1">
          <TextInput
            value={positionRef}
            onChange={(e) => setPositionRef(e.target.value)}
            placeholder="Optional"
          />
        </Field>
        <Field label="Quantity" required>
          <TextInput
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Notes">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional installation or sourcing notes"
          rows={2}
        />
      </Field>

      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting || !selectedPartId}>
          {submitting ? 'Adding…' : 'Add to BOM'}
        </PrimaryButton>
      </div>
    </form>
  );
}
