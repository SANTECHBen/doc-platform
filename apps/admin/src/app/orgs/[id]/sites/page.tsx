'use client';

// Org-scoped sites listing. The org overview also shows a sites table,
// but a dedicated page gives sites their own URL for bookmarking and
// makes them feel as first-class as Assets / Content. Add-site reuses
// the same drawer pattern as the overview.

import { use, useEffect, useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
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
} from '@/components/form';
import {
  createSite,
  listOrganizations,
  listSitesForOrg,
  type AdminOrganization,
} from '@/lib/api';

type Site = {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string;
};

export default function OrgSitesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [s, orgs] = await Promise.all([
        listSitesForOrg(orgId),
        listOrganizations(),
      ]);
      setSites(s);
      setOrg(orgs.find((o) => o.id === orgId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Sites' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Sites"
          description="Physical locations belonging to this organization. Each serial-numbered piece of equipment lives at a site."
          actions={
            <PrimaryButton onClick={() => setDrawerOpen(true)}>
              <Plus size={14} strokeWidth={2} /> Add site
            </PrimaryButton>
          }
        />
        <ErrorBanner error={error} />
        {sites === null ? (
          <TableSkeleton cols={4} rows={4} />
        ) : sites.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="No sites yet"
            description="Add a site to host serial-numbered equipment. End-customers must have at least one; OEMs and integrators usually skip."
            action={
              <PrimaryButton onClick={() => setDrawerOpen(true)}>
                <Plus size={14} strokeWidth={2} /> Add the first site
              </PrimaryButton>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Location</th>
                  <th className="px-4 py-2">Timezone</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3 font-medium text-ink-primary">
                      {s.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                      {s.code ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {[s.city, s.region, s.country].filter(Boolean).join(', ') ||
                        '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">{s.timezone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Drawer
          title={`Add site to ${org?.name ?? ''}`}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        >
          <NewSiteForm
            orgId={orgId}
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

function NewSiteForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [country, setCountry] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createSite({
        organizationId: orgId,
        name: name.trim(),
        code: code.trim() || undefined,
        city: city.trim() || undefined,
        region: region.trim() || undefined,
        country: country.trim() || undefined,
        postalCode: postalCode.trim() || undefined,
        timezone: timezone.trim() || 'UTC',
      });
      toast.success(`${name.trim()} added`, 'Site ready for instances.');
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
      <Field label="Name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Memphis DC"
          required
        />
      </Field>
      <Field label="Code" hint="Short site identifier used in operations.">
        <TextInput
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="MEM-DC-01"
          maxLength={64}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City">
          <TextInput value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Region / state">
          <TextInput value={region} onChange={(e) => setRegion(e.target.value)} />
        </Field>
        <Field label="Country">
          <TextInput
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="US"
            maxLength={64}
          />
        </Field>
        <Field label="Postal code">
          <TextInput
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            maxLength={32}
          />
        </Field>
      </div>
      <Field
        label="Timezone"
        hint="IANA tz database name. Affects how scheduled tasks render at this site."
      >
        <TextInput
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="America/Chicago"
        />
      </Field>
      <div className="mt-2 flex justify-end">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Add site'}
        </PrimaryButton>
      </div>
    </form>
  );
}
