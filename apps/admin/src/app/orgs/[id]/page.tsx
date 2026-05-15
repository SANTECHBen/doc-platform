'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { use, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Bot,
  FileStack,
  GraduationCap,
  MapPin,
  Plus,
  QrCode,
  Settings,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { PageHeader, Pill } from '@/components/page-shell';
import { SetupStatusCard } from '@/components/setup-status-card';
import {
  Drawer,
  ErrorBanner,
  Field,
  PrimaryButton,
  TextInput,
} from '@/components/form';
import { useToast } from '@/components/toast';
import {
  createSite,
  getOrganizationSummary,
  listOrganizations,
  listSitesForOrg,
  type AdminOrganization,
  type OrganizationSummary,
} from '@/lib/api';
import { computeSetupStatus, type SetupStepId } from '@/lib/setup-status';
import { FirstRunWizard } from './first-run-wizard';

export default function OrgOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const stepFromUrl = searchParams?.get('step') as SetupStepId | null;
  const showWizard = searchParams?.get('wizard') === '1';

  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [children, setChildren] = useState<AdminOrganization[]>([]);
  const [sites, setSites] = useState<
    Array<{
      id: string;
      name: string;
      code: string | null;
      city: string | null;
      region: string | null;
      country: string | null;
      timezone: string;
    }>
  >([]);
  const [summary, setSummary] = useState<OrganizationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteDrawerOpen, setSiteDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [orgs, s, sum] = await Promise.all([
        listOrganizations(),
        listSitesForOrg(id),
        getOrganizationSummary(id),
      ]);
      const found = orgs.find((o) => o.id === id) ?? null;
      setOrg(found);
      setChildren(orgs.filter((o) => o.parent?.id === id));
      setSites(s);
      setSummary(sum);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const setupStatus = useMemo(
    () =>
      summary
        ? computeSetupStatus(summary, { routePrefix: 'org-scoped' })
        : null,
    [summary],
  );

  if (error) return <ErrorBanner error={error} />;
  if (!org || !summary)
    return (
      <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
    );

  const base = `/orgs/${id}`;

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org.name },
          ]}
        />
      </TopBar>

      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title={org.name}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <Pill tone={TYPE_TONE[org.type]}>{org.type.replace('_', ' ')}</Pill>
              <span className="font-mono text-xs text-ink-tertiary">
                {org.slug}
                {org.oemCode ? ` · ${org.oemCode}` : ''}
              </span>
              {org.parent && (
                <span className="text-sm text-ink-tertiary">
                  Parent:{' '}
                  <Link
                    href={`/orgs/${org.parent.id}`}
                    className="text-brand hover:text-brand-strong"
                  >
                    {org.parent.name}
                  </Link>
                </span>
              )}
            </span>
          }
          actions={
            <Link href={`${base}/settings`} className="btn btn-secondary btn-sm">
              <Settings size={14} strokeWidth={2} /> Settings
            </Link>
          }
        />

        {setupStatus && (
          <SetupStatusCard
            status={setupStatus}
            highlightStepId={stepFromUrl}
            onScrollTo={(anchor) => {
              const el = document.getElementById(anchor);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth' });
                if (anchor === 'sites-section' && sites.length === 0) {
                  setSiteDrawerOpen(true);
                }
              }
            }}
          />
        )}

        <QuickLinks base={base} summary={summary} />

        <SitesSection
          org={org}
          sites={sites}
          onAddClick={() => setSiteDrawerOpen(true)}
        />

        {children.length > 0 && (
          <DownstreamSection children={children} />
        )}

        <Drawer
          title={`Add site to ${org.name}`}
          open={siteDrawerOpen}
          onClose={() => setSiteDrawerOpen(false)}
        >
          <NewSiteForm
            orgId={id}
            onCreated={async () => {
              setSiteDrawerOpen(false);
              await refresh();
            }}
          />
        </Drawer>

        {showWizard && (
          <FirstRunWizard
            orgId={id}
            org={org}
            sites={sites}
            summary={summary}
            onRefresh={refresh}
          />
        )}
      </div>
    </>
  );
}

const TYPE_TONE = {
  oem: 'info',
  dealer: 'default',
  integrator: 'default',
  end_customer: 'success',
} as const;

// Card row of clickable shortcuts into the most common sub-pages — gives
// the admin a visual map of "what lives in this workspace" without
// forcing them to scan the sidebar text-by-text. Counts come from the
// org summary so admins can see at-a-glance whether anything's there.
function QuickLinks({
  base,
  summary,
}: {
  base: string;
  summary: OrganizationSummary;
}) {
  const items: Array<{
    href: string;
    label: string;
    icon: LucideIcon;
    count: number;
    suffix: string;
  }> = [
    {
      href: `${base}/asset-models`,
      label: 'Asset models',
      icon: Boxes,
      count: summary.assetModelCount,
      suffix: 'models',
    },
    {
      href: `${base}/parts`,
      label: 'Parts',
      icon: Wrench,
      count: summary.partCount,
      suffix: 'in catalog',
    },
    {
      href: `${base}/content-packs`,
      label: 'Content packs',
      icon: FileStack,
      count: summary.contentPackCount,
      suffix: `${summary.contentPackVersionPublishedCount} published`,
    },
    {
      href: `${base}/training`,
      label: 'Training',
      icon: GraduationCap,
      count: summary.trainingModuleCount,
      suffix: 'modules',
    },
    {
      href: `${base}/qr-codes`,
      label: 'QR codes',
      icon: QrCode,
      count: summary.qrCodeCount,
      suffix: 'active',
    },
    {
      href: `${base}/users`,
      label: 'Users',
      icon: Users,
      count: 0,
      suffix: 'with access',
    },
    {
      href: `${base}/agent`,
      label: 'Onboarding agent',
      icon: Bot,
      count: 0,
      suffix: 'AI ingest',
    },
  ];
  return (
    <section className="mb-8">
      <h2 className="caption mb-3">Workspace</h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <Link
              key={it.href}
              href={it.href}
              className="group flex flex-col gap-2 rounded-md border border-line-subtle bg-surface-raised p-3 transition hover:border-brand/40 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <Icon
                  size={16}
                  strokeWidth={1.75}
                  className="text-ink-tertiary group-hover:text-brand"
                />
                <ArrowRight
                  size={12}
                  strokeWidth={2}
                  className="text-ink-tertiary opacity-0 transition group-hover:opacity-100"
                />
              </div>
              <div>
                <div className="text-sm font-medium text-ink-primary">
                  {it.label}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-ink-tertiary">
                  {it.count > 0 ? `${it.count} ${it.suffix}` : it.suffix}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function SitesSection({
  org,
  sites,
  onAddClick,
}: {
  org: AdminOrganization;
  sites: Array<{
    id: string;
    name: string;
    code: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    timezone: string;
  }>;
  onAddClick: () => void;
}) {
  return (
    <section id="sites-section" className="mb-8">
      <div className="mb-3 flex items-end justify-between">
        <h2 className="caption">
          Sites ({sites.length})
          <span className="ml-1 text-ink-tertiary">— physical locations</span>
        </h2>
        <button
          type="button"
          onClick={onAddClick}
          className="btn btn-secondary btn-sm"
        >
          <Plus size={14} strokeWidth={2} /> Add site
        </button>
      </div>
      {sites.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
          {org.type === 'oem'
            ? 'No sites yet. Add one if you have pre-deployment units (factory floor, demo, showroom). Otherwise sites typically live on the end-customer organizations beneath this OEM.'
            : org.type === 'integrator'
            ? 'No sites yet. Add one for a staging / commissioning facility, or skip — sites typically live on end-customers.'
            : 'No sites yet. Add a site to host serial-numbered equipment.'}
        </p>
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
    </section>
  );
}

function DownstreamSection({ children }: { children: AdminOrganization[] }) {
  return (
    <section className="mb-8">
      <h2 className="caption mb-3">
        Downstream organizations ({children.length})
        <span className="ml-1 text-ink-tertiary">— dealers, integrators, end customers under this one</span>
      </h2>
      <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
        <table className="data-table">
          <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
            <tr>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Sites</th>
            </tr>
          </thead>
          <tbody>
            {children.map((c) => (
              <tr key={c.id} className="border-t border-line-subtle">
                <td className="px-4 py-3">
                  <Pill tone={TYPE_TONE[c.type]}>{c.type.replace('_', ' ')}</Pill>
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/orgs/${c.id}`}
                    className="font-medium text-ink-primary hover:text-brand"
                  >
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-3">{c.siteCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
