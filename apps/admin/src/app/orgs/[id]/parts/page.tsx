'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { Plus, Wrench } from 'lucide-react';
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
  TextInput,
  Textarea,
} from '@/components/form';
import {
  createPart,
  listAdminParts,
  listOrganizations,
  type AdminPart,
  type AdminOrganization,
} from '@/lib/api';

const PART_ROLES: Array<{ value: AdminPart['role']; label: string }> = [
  { value: 'part', label: 'Part' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'sub_assembly', label: 'Sub-assembly' },
  { value: 'component', label: 'Component' },
];

export default function OrgPartsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [allParts, setAllParts] = useState<AdminPart[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');

  async function refresh() {
    try {
      const [parts, orgs] = await Promise.all([
        listAdminParts(),
        listOrganizations(),
      ]);
      setAllParts(parts);
      setOrg(orgs.find((o) => o.id === orgId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const owned = useMemo(() => {
    const list = (allParts ?? []).filter((p) => p.owner === orgId);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.displayName.toLowerCase().includes(q) ||
        p.oemPartNumber.toLowerCase().includes(q) ||
        p.crossReferences.some((x) => x.toLowerCase().includes(q)),
    );
  }, [allParts, orgId, query]);

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Parts' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Parts catalog"
          description="Replacement parts owned by this organization. Parts get attached to asset models via BOMs and to procedures so techs can order what they need from the field."
          actions={
            <PrimaryButton onClick={() => setDrawerOpen(true)}>
              <Plus size={14} strokeWidth={2} /> New part
            </PrimaryButton>
          }
        />
        <ErrorBanner error={error} />
        {allParts === null ? (
          <TableSkeleton cols={4} rows={5} />
        ) : (allParts ?? []).filter((p) => p.owner === orgId).length === 0 ? (
          <EmptyState
            icon={Wrench}
            title="No parts in catalog yet"
            description="Add the first replacement part. You can attach it to asset models afterwards via BOMs."
            action={
              <PrimaryButton onClick={() => setDrawerOpen(true)}>
                <Plus size={14} strokeWidth={2} /> Add a part
              </PrimaryButton>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by part number, name, or cross-reference…"
              className="form-input max-w-sm"
              aria-label="Filter parts"
            />
            <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
              <table className="data-table">
                <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                  <tr>
                    <th className="px-4 py-2">Part #</th>
                    <th className="px-4 py-2">Display name</th>
                    <th className="px-4 py-2">Role</th>
                    <th className="px-4 py-2">BOM uses</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {owned.map((p) => (
                    <tr key={p.id} className="border-t border-line-subtle">
                      <td className="px-4 py-3 font-mono text-xs text-ink-primary">
                        {p.oemPartNumber}
                      </td>
                      <td className="px-4 py-3 font-medium text-ink-primary">
                        {p.displayName}
                      </td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {PART_ROLES.find((r) => r.value === p.role)?.label ?? p.role}
                      </td>
                      <td className="px-4 py-3 tnum">{p.bomCount}</td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {p.discontinued ? (
                          <span className="text-signal-warn">Discontinued</span>
                        ) : (
                          'Active'
                        )}
                      </td>
                    </tr>
                  ))}
                  {owned.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-sm text-ink-tertiary">
                        No parts match {JSON.stringify(query)}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Drawer
          title="New part"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        >
          <NewPartForm
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

function NewPartForm({
  ownerOrganizationId,
  onCreated,
}: {
  ownerOrganizationId: string;
  onCreated: () => Promise<void>;
}) {
  const [oemPartNumber, setOemPartNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createPart({
        ownerOrganizationId,
        oemPartNumber: oemPartNumber.trim(),
        displayName: displayName.trim(),
        description: description.trim() || undefined,
      });
      toast.success(`${displayName.trim()} added`, 'Part is in the catalog.');
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
      <Field label="OEM part number" required>
        <TextInput
          value={oemPartNumber}
          onChange={(e) => setOemPartNumber(e.target.value)}
          placeholder="FT-PUR-0042"
          required
        />
      </Field>
      <Field label="Display name" required>
        <TextInput
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Polyurethane belt cleat"
          required
        />
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </Field>
      <div className="mt-2 flex justify-end">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Add part'}
        </PrimaryButton>
      </div>
    </form>
  );
}
