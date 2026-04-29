'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { NextStepHint } from '@/components/next-step-hint';
import { TableSkeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
} from '@/components/form';
import {
  createOrganization,
  listOrganizations,
  type AdminOrganization,
} from '@/lib/api';

const TYPE_TONE = {
  oem: 'info',
  dealer: 'default',
  integrator: 'default',
  end_customer: 'success',
} as const;

export default function OrganizationsPage() {
  const [rows, setRows] = useState<AdminOrganization[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  return (
    <PageShell crumbs={[{ label: 'Organizations' }]}>
      <PageHeader
        title="Organizations"
        description="All tenants. OEMs author base content; dealers and integrators overlay; end customers consume."
        actions={
          <PrimaryButton onClick={() => setDrawerOpen(true)}>
            <Plus size={14} strokeWidth={2} /> New organization
          </PrimaryButton>
        }
      />
      <ErrorBanner error={error} />
      <NextStepHint page="tenants" />
      {rows === null ? (
        <TableSkeleton cols={6} rows={5} />
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
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="data-table">
            <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Parent</th>
                <th className="px-4 py-2">OEM code</th>
                <th className="px-4 py-2">Sites</th>
                <th className="px-4 py-2">Users</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-t border-line-subtle">
                  <td className="px-4 py-3">
                    <Pill tone={TYPE_TONE[o.type]}>{o.type.replace('_', ' ')}</Pill>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/tenants/${o.id}`}
                      className="block font-medium text-ink-primary hover:text-brand"
                    >
                      {o.name}
                    </Link>
                    <span className="block font-mono text-xs text-ink-tertiary">{o.slug}</span>
                  </td>
                  <td className="px-4 py-3 text-ink-secondary">{o.parent?.name ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                    {o.oemCode ?? '—'}
                  </td>
                  <td className="px-4 py-3">{o.siteCount}</td>
                  <td className="px-4 py-3">{o.userCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        title="New organization"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <NewOrgForm
          orgs={rows ?? []}
          onCreated={async () => {
            setDrawerOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </PageShell>
  );
}

function NewOrgForm({
  orgs,
  onCreated,
}: {
  orgs: AdminOrganization[];
  onCreated: () => Promise<void>;
}) {
  const [type, setType] = useState<'oem' | 'dealer' | 'integrator' | 'end_customer'>('oem');
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
      await createOrganization({
        type,
        name: name.trim(),
        slug: slug.trim(),
        // Parent is meaningless for OEMs and only required for end_customers.
        // Integrators and dealers may have a parent if they're captive to one
        // OEM, but most are independent — leave the field blank then.
        parentOrganizationId: type === 'oem' ? undefined : parentOrganizationId || undefined,
        oemCode: oemCode.trim() || undefined,
      });
      toast.success(`${name.trim()} created`, `${type.replace('_', ' ')} tenant ready.`);
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Only end_customers strictly need a parent (the integrator/OEM that
  // installed them). Integrators and dealers may have a parent (captive
  // arrangements) but more often don't. OEMs are always top-level.
  const parentRequired = type === 'end_customer';
  const parentVisible = type !== 'oem';
  const eligibleParents = orgs.filter((o) => o.type !== 'end_customer');

  // Per-type help text for the parent field — explains the data model
  // briefly so admins don't have to guess.
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
          {submitting ? 'Creating…' : 'Create organization'}
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
