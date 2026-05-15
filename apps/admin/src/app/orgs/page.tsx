'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Building2, Plus, Search } from 'lucide-react';
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
  createOrganization,
  listOrganizations,
  type AdminOrganization,
} from '@/lib/api';
import { useRouter } from 'next/navigation';

const TYPE_TONE = {
  oem: 'info',
  dealer: 'default',
  integrator: 'default',
  end_customer: 'success',
} as const;

// The canonical entry point for the admin app post-refactor. Lists every
// organization the signed-in admin can access; clicking one drops them
// into that org's workspace. Replaces the old /tenants listing.
//
// Org creation lives here as a drawer (matches the historical pattern).
// On successful creation we route the admin into the new org's
// workspace and open the first-run wizard so they can finish the
// minimum viable setup before bouncing back out.
export default function OrgsPickerPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdminOrganization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');

  async function refresh() {
    try {
      setRows(await listOrganizations());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q) ||
        (r.oemCode ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <PageShell crumbs={[{ label: 'Organizations' }]}>
      <PageHeader
        title="Organizations"
        description="Pick a customer to enter their workspace. Each organization has its own setup, content library, and operations."
        actions={
          <PrimaryButton onClick={() => setDrawerOpen(true)}>
            <Plus size={14} strokeWidth={2} /> New organization
          </PrimaryButton>
        }
      />
      <ErrorBanner error={error} />

      {rows === null ? (
        <TableSkeleton cols={4} rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Create the first OEM (the equipment manufacturer you work with). Later, add their dealers and end-customer sites under it."
          action={
            <PrimaryButton onClick={() => setDrawerOpen(true)}>
              <Plus size={14} strokeWidth={2} /> Create the first OEM
            </PrimaryButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="relative max-w-sm">
            <Search
              size={14}
              strokeWidth={2}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, slug, OEM code…"
              className="form-input w-full pl-8"
              aria-label="Filter organizations"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(filtered ?? []).map((o) => (
              <OrgCard key={o.id} org={o} />
            ))}
            {filtered && filtered.length === 0 && (
              <p className="col-span-full rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-tertiary">
                No organizations match {JSON.stringify(query)}.
              </p>
            )}
          </div>
        </div>
      )}

      <Drawer
        title="New organization"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <NewOrgForm
          orgs={rows ?? []}
          onCreated={async (created) => {
            setDrawerOpen(false);
            await refresh();
            // Drop straight into the new org's workspace and pop the
            // first-run wizard so the admin can chain through setup
            // without bouncing back to the picker.
            router.push(`/orgs/${created.id}?wizard=1`);
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function OrgCard({ org }: { org: AdminOrganization }) {
  return (
    <Link
      href={`/orgs/${org.id}`}
      className="group flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4 transition hover:border-brand/40 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded font-mono text-sm font-bold"
            style={{
              background: org.brand.primary
                ? `${org.brand.primary}26`
                : 'rgb(var(--brand) / 0.15)',
              color: org.brand.primary ?? 'rgb(var(--brand))',
            }}
            aria-hidden
          >
            {initials(org.name)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink-primary group-hover:text-brand">
              {org.name}
            </div>
            <div className="truncate font-mono text-xs text-ink-tertiary">
              {org.slug}
              {org.oemCode ? ` · ${org.oemCode}` : ''}
            </div>
          </div>
        </div>
        <Pill tone={TYPE_TONE[org.type]}>{org.type.replace('_', ' ')}</Pill>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
        <div className="flex items-center gap-1">
          <dt className="text-ink-tertiary">Sites</dt>
          <dd className="tnum font-medium text-ink-primary">{org.siteCount}</dd>
        </div>
        <div className="flex items-center gap-1">
          <dt className="text-ink-tertiary">Users</dt>
          <dd className="tnum font-medium text-ink-primary">{org.userCount}</dd>
        </div>
        {org.parent && (
          <div className="flex items-center gap-1 truncate">
            <dt className="text-ink-tertiary">Parent</dt>
            <dd className="truncate font-medium text-ink-primary">
              {org.parent.name}
            </dd>
          </div>
        )}
      </dl>
    </Link>
  );
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '·'
  );
}

function NewOrgForm({
  orgs,
  onCreated,
}: {
  orgs: AdminOrganization[];
  onCreated: (created: { id: string }) => Promise<void>;
}) {
  const [type, setType] = useState<'oem' | 'dealer' | 'integrator' | 'end_customer'>(
    'oem',
  );
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [parentOrganizationId, setParentOrganizationId] = useState('');
  const [oemCode, setOemCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  function onNameChange(next: string) {
    setName(next);
    if (!slugEdited) setSlug(autoSlug(next));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await createOrganization({
        type,
        name: name.trim(),
        slug: slug.trim(),
        parentOrganizationId:
          type === 'oem' ? undefined : parentOrganizationId || undefined,
        oemCode: oemCode.trim() || undefined,
      });
      toast.success(
        `${name.trim()} created`,
        `${type.replace('_', ' ')} workspace ready.`,
      );
      await onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const parentRequired = type === 'end_customer';
  const parentVisible = type !== 'oem';
  const eligibleParents = orgs.filter((o) => o.type !== 'end_customer');
  const parentHint =
    type === 'end_customer'
      ? 'Required. Typically the integrator who installed their equipment, or the OEM if direct.'
      : type === 'integrator'
      ? 'Optional. Leave blank for an independent integrator (most common). Only set if you contract through a specific OEM.'
      : type === 'dealer'
      ? 'Optional. Leave blank for a multi-OEM dealer. Set if this dealer exclusively resells one OEM.'
      : '';

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorBanner error={error} />
      <Field label="Type" required>
        <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="oem">OEM</option>
          <option value="dealer">Dealer</option>
          <option value="integrator">Integrator</option>
          <option value="end_customer">End customer</option>
        </Select>
      </Field>
      <Field label="Name" required>
        <TextInput
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Flow Turn"
          required
        />
      </Field>
      <Field
        label="Slug"
        required
        hint="URL-safe identifier, lowercase letters, digits, hyphens."
      >
        <TextInput
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
          placeholder="flow-turn"
          pattern="[a-z0-9\-]+"
          required
        />
      </Field>
      {parentVisible && (
        <Field
          label="Parent organization"
          required={parentRequired}
          hint={parentHint}
        >
          <Select
            value={parentOrganizationId}
            onChange={(e) => setParentOrganizationId(e.target.value)}
            required={parentRequired}
          >
            <option value="">
              {parentRequired ? 'Select parent…' : '— None (independent)'}
            </option>
            {eligibleParents.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.type}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {type === 'oem' && (
        <Field
          label="OEM code"
          hint="Short vendor code used by content authors. e.g. FLOWTURN."
        >
          <TextInput
            value={oemCode}
            onChange={(e) => setOemCode(e.target.value.toUpperCase())}
            placeholder="FLOWTURN"
            maxLength={60}
          />
        </Field>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create & enter workspace'}
        </PrimaryButton>
      </div>
    </form>
  );
}

function autoSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
