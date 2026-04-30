'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ImagePlus, Layers, Package, Plus, Trash2, Wrench, X } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
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
import { useToast } from '@/components/toast';
import {
  addPartComponent,
  createPart,
  listAdminParts,
  listOrganizations,
  listPartComponents,
  listSectionsForPart,
  removePartComponent,
  updatePartImage,
  uploadFile,
  type AdminOrganization,
  type AdminPart,
  type AdminPartSection,
  type PartComponent,
} from '@/lib/api';
import { nextStepAfterSave } from '@/lib/setup-status';

export default function PartsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const continueOrgId = searchParams?.get('continue') ?? null;
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

  useEffect(() => {
    if (continueOrgId && oems.length > 0) setDrawerOpen(true);
  }, [continueOrgId, oems.length]);

  const continueOrg = continueOrgId ? oems.find((o) => o.id === continueOrgId) ?? null : null;

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
                <th className="px-4 py-2">Role</th>
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
        title={continueOrg ? `New part for ${continueOrg.name}` : 'New part'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <NewPartForm
          oems={oems}
          lockedOrg={continueOrg}
          onCreated={async (continueSetup) => {
            setDrawerOpen(false);
            await refresh();
            if (continueSetup && continueOrg) {
              const next = nextStepAfterSave('parts_bom', continueOrg.type) ?? 'content_published';
              router.push(`/tenants/${continueOrg.id}?step=${next}`);
            }
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function NewPartForm({
  oems,
  lockedOrg,
  onCreated,
}: {
  oems: AdminOrganization[];
  lockedOrg: AdminOrganization | null;
  onCreated: (continueSetup: boolean) => Promise<void>;
}) {
  const [ownerId, setOwnerId] = useState(lockedOrg?.id ?? oems[0]?.id ?? '');
  const [oemPartNumber, setOemPartNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [crossRefsRaw, setCrossRefsRaw] = useState('');
  const [imageStorageKey, setImageStorageKey] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [continueAfter, setContinueAfter] = useState(false);
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
      {lockedOrg ? (
        <Field label="OEM">
          <div className="flex items-center gap-2 rounded border border-line-subtle bg-surface-inset px-3 py-2 text-sm">
            <span className="font-medium">{lockedOrg.name}</span>
            <span className="text-xs text-ink-tertiary">(continuing setup for this tenant)</span>
          </div>
        </Field>
      ) : (
        <Field label="OEM" required>
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required>
            {oems.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
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
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {lockedOrg && (
          <SecondaryButton
            type="submit"
            disabled={submitting || uploading}
            onClick={() => setContinueAfter(true)}
          >
            {submitting && continueAfter ? 'Saving…' : 'Save & continue setup'}
          </SecondaryButton>
        )}
        <PrimaryButton
          type="submit"
          disabled={submitting || uploading}
          onClick={() => setContinueAfter(false)}
        >
          {submitting && !continueAfter ? 'Creating…' : lockedOrg ? 'Save' : 'Create part'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function PartRow({ part, onRefresh }: { part: AdminPart; onRefresh: () => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
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
      <td className="px-4 py-3">
        {part.role !== 'part' && (
          <span className={part.role === 'component' ? 'pill' : 'pill pill-info'}>
            {part.role === 'assembly'
              ? 'Assembly'
              : part.role === 'sub_assembly'
              ? 'Sub-assembly'
              : 'Component'}
          </span>
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
        <div className="flex items-center gap-2">
          {part.discontinued && <Pill tone="warning">discontinued</Pill>}
          <button
            type="button"
            onClick={() => setComponentsOpen(true)}
            className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-inset hover:text-ink-primary"
            title="Manage sub-parts that make up this part"
          >
            <Layers size={12} strokeWidth={2} />
            Components
          </button>
          <button
            type="button"
            onClick={() => setSectionsOpen(true)}
            className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-inset hover:text-ink-primary"
            title="Document sections linked to this part"
          >
            Sections
          </button>
        </div>
      </td>
      <Drawer
        title={`Components — ${part.displayName}`}
        open={componentsOpen}
        onClose={() => setComponentsOpen(false)}
      >
        <ComponentsPanel part={part} />
      </Drawer>
      <Drawer
        title={`Sections linked to ${part.displayName}`}
        open={sectionsOpen}
        onClose={() => setSectionsOpen(false)}
      >
        <PartSectionsPanel partId={part.id} />
      </Drawer>
    </tr>
  );
}

// Sub-parts drawer — shows current components of a part and lets the author
// add/remove them. Mirrors the BOM panel pattern from asset-model detail.
function ComponentsPanel({ part }: { part: AdminPart }) {
  const [entries, setEntries] = useState<PartComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allParts, setAllParts] = useState<AdminPart[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      setEntries(await listPartComponents(part.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    listAdminParts()
      .then(setAllParts)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.id]);

  async function onRemove(linkId: string, childName: string) {
    if (!confirm(`Remove "${childName}" from ${part.displayName}'s components?`)) return;
    try {
      await removePartComponent(linkId);
      toast.success('Component removed');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="rounded border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          Sub-parts that make up <span className="font-mono text-ink-primary">{part.oemPartNumber}</span>.
          Technicians can drill in on the PWA to find replacement parts at any depth.
        </p>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="btn btn-primary btn-sm shrink-0"
        >
          <Plus size={13} strokeWidth={2} /> Add
        </button>
      </div>

      {entries === null ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
          No components yet. Add a sub-part to build this part's hierarchy.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <li
              key={e.linkId}
              className="flex items-center gap-3 rounded-md border border-line bg-surface-raised px-3 py-2.5"
            >
              {e.imageUrl ? (
                <img
                  src={e.imageUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded object-contain p-0.5"
                  style={{
                    background: 'rgb(var(--surface-inset))',
                    border: '1px solid rgb(var(--line-subtle))',
                  }}
                />
              ) : (
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-ink-tertiary"
                  style={{
                    background: 'rgb(var(--surface-inset))',
                    border: '1px solid rgb(var(--line-subtle))',
                  }}
                >
                  <Package size={14} strokeWidth={1.5} />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-ink-brand">{e.oemPartNumber}</span>
                  <span className="truncate text-sm text-ink-primary">{e.displayName}</span>
                </div>
                <div className="flex gap-3 font-mono text-[11px] text-ink-tertiary">
                  {e.positionRef && <span>Pos {e.positionRef}</span>}
                  <span>Qty {e.quantity}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(e.linkId, e.displayName)}
                aria-label={`Remove ${e.displayName}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-tertiary transition hover:bg-surface-inset hover:text-signal-fault"
                title="Remove"
              >
                <Trash2 size={14} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Drawer
        title="Add component"
        open={addOpen}
        onClose={() => setAddOpen(false)}
      >
        <AddComponentForm
          parent={part}
          allParts={allParts}
          existingChildIds={new Set((entries ?? []).map((e) => e.childPartId))}
          onAdded={async () => {
            setAddOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </div>
  );
}

function AddComponentForm({
  parent,
  allParts,
  existingChildIds,
  onAdded,
}: {
  parent: AdminPart;
  allParts: AdminPart[] | null;
  existingChildIds: Set<string>;
  onAdded: () => Promise<void>;
}) {
  const [selectedChildId, setSelectedChildId] = useState('');
  const [search, setSearch] = useState('');
  const [positionRef, setPositionRef] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = allParts
    ? allParts
        .filter((p) => p.id !== parent.id && !existingChildIds.has(p.id))
        .filter((p) => {
          const q = search.trim().toLowerCase();
          if (!q) return true;
          return [p.oemPartNumber, p.displayName, p.description ?? '', p.owner]
            .join(' ')
            .toLowerCase()
            .includes(q);
        })
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedChildId) {
      setError('Pick a sub-part first.');
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
      await addPartComponent(parent.id, {
        childPartId: selectedChildId,
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
          placeholder="OEM #, name, description"
          autoFocus
        />
      </Field>

      <div>
        <span className="form-label">Sub-part</span>
        {available === null ? (
          <p className="mt-1.5 p-3 text-sm text-ink-tertiary">Loading…</p>
        ) : available.length === 0 ? (
          <p className="mt-1.5 rounded border border-dashed border-line p-3 text-sm text-ink-tertiary">
            No eligible parts. Create the sub-part in the catalog first.
          </p>
        ) : (
          <ul className="mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto rounded border border-line p-1">
            {available.map((p) => (
              <li key={p.id}>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
                    selectedChildId === p.id
                      ? 'bg-brand-soft text-ink-primary'
                      : 'hover:bg-surface-elevated'
                  }`}
                >
                  <input
                    type="radio"
                    name="component"
                    value={p.id}
                    checked={selectedChildId === p.id}
                    onChange={() => setSelectedChildId(p.id)}
                    className="shrink-0"
                  />
                  <span className="font-mono text-xs text-ink-brand">{p.oemPartNumber}</span>
                  <span className="truncate text-ink-primary">{p.displayName}</span>
                  <span className="ml-auto shrink-0 text-xs text-ink-tertiary">{p.owner}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Position" hint="Optional">
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
          placeholder="Optional"
          rows={2}
        />
      </Field>

      <div className="flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting || !selectedChildId}>
          {submitting ? 'Adding…' : 'Add component'}
        </PrimaryButton>
      </div>
    </form>
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

// Lists all document sections that link to this part. Each row shows the
// section title, kind, parent document, and a deep link to the document's
// sections tab so the admin can edit it in place.
function PartSectionsPanel({ partId }: { partId: string }) {
  const [rows, setRows] = useState<AdminPartSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    listSectionsForPart(partId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [partId]);

  if (error) return <p className="text-sm text-signal-fault">{error}</p>;
  if (!rows) return <p className="text-sm text-ink-tertiary">Loading…</p>;
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-tertiary">
        No document sections link to this part yet. Open a document and add a section.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((s) => (
        <li
          key={s.id}
          className="rounded-md border border-line-subtle bg-surface-raised p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink-primary">{s.title}</p>
              <p className="mt-0.5 truncate text-xs text-ink-tertiary">
                {s.documentTitle} · {s.kind.replace(/_/g, ' ')}
              </p>
            </div>
            <Link
              href={`/documents/${s.documentId}?tab=sections`}
              className="shrink-0 rounded border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-inset hover:text-ink-primary"
            >
              Open
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
