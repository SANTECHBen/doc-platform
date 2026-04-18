'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { MapPin, Palette, Plus, Upload } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import { uploadFile, updateOrgBranding } from '@/lib/api';
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

export default function OrgDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
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
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function refresh() {
    try {
      const [orgs, s] = await Promise.all([listOrganizations(), listSitesForOrg(id)]);
      const found = orgs.find((o) => o.id === id) ?? null;
      setOrg(found);
      setChildren(orgs.filter((o) => o.parent?.id === id));
      setSites(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <ErrorBanner error={error} />;
  if (!org) return <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>;

  return (
    <PageShell
      crumbs={[
        { label: 'Organizations', href: '/tenants' },
        { label: org.name },
      ]}
    >
      <PageHeader
        title={org.name}
        description={`${org.type.replace('_', ' ')} · ${org.slug}${org.oemCode ? ` · ${org.oemCode}` : ''}`}
        actions={
          <PrimaryButton onClick={() => setDrawerOpen(true)}>
            <Plus size={14} strokeWidth={2} /> Add site
          </PrimaryButton>
        }
      />

      {org.parent && (
        <p className="mb-6 text-sm text-ink-secondary">
          Parent:{' '}
          <Link href={`/tenants/${org.parent.id}`} className="text-brand hover:text-brand-strong">
            {org.parent.name}
          </Link>
        </p>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
          Sites ({sites.length})
        </h2>
        {sites.length === 0 ? (
          <p className="rounded-md border border-dashed border-line p-4 text-center text-sm text-ink-tertiary">
            No sites yet. Add one to deploy asset instances.
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
                    <td className="px-4 py-3 font-medium text-ink-primary">{s.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                      {s.code ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {[s.city, s.region, s.country].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">{s.timezone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {children.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Downstream orgs ({children.length})
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
                      <Pill>{c.type.replace('_', ' ')}</Pill>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/tenants/${c.id}`}
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
      )}

      {org.type === 'oem' && <BrandingSection org={org} onChanged={refresh} />}

      <Drawer
        title={`Add site to ${org.name}`}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      >
        <NewSiteForm
          orgId={id}
          onCreated={async () => {
            setDrawerOpen(false);
            await refresh();
          }}
        />
      </Drawer>
    </PageShell>
  );
}

// Branding section — only OEMs get it. When a QR scan resolves to equipment
// this OEM owns, the PWA uses these values to rebrand the asset hub.
function BrandingSection({
  org,
  onChanged,
}: {
  org: import('@/lib/api').AdminOrganization;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(org.brand.displayNameOverride ?? '');
  const [primary, setPrimary] = useState(org.brand.primary ?? '#4D90E5');
  const [onPrimary, setOnPrimary] = useState(org.brand.onPrimary ?? '#FFFFFF');
  const [logoUrl, setLogoUrl] = useState<string | null>(org.brand.logoUrl);
  const [logoStorageKey, setLogoStorageKey] = useState<string | null>(
    org.brand.logoStorageKey,
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLogoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const r = await uploadFile(file);
      setLogoStorageKey(r.storageKey);
      setLogoUrl(r.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateOrgBranding(org.id, {
        displayNameOverride: displayName.trim() || null,
        brandPrimary: primary || null,
        brandOnPrimary: onPrimary || null,
        logoStorageKey: logoStorageKey,
      });
      toast.success('Branding saved', 'Applied on the next QR scan.');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearLogo() {
    setLogoStorageKey(null);
    setLogoUrl(null);
  }

  const displayedName = displayName.trim() || org.name;
  const previewInitials = displayedName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <section className="mb-8 rounded-md border border-line bg-surface-raised p-6">
      <div className="mb-5 flex items-center gap-2">
        <Palette size={16} className="text-ink-tertiary" strokeWidth={1.75} />
        <h2 className="caption">White-label branding</h2>
      </div>
      <p className="mb-5 max-w-xl text-sm text-ink-secondary">
        Applied to the PWA when a technician scans equipment you own. They'll see your logo,
        wordmark, and accent color instead of Equipment Hub's default brand.
      </p>

      {error && (
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'rgba(var(--signal-fault) / 0.4)',
            background: 'rgba(var(--signal-fault) / 0.1)',
            color: 'rgb(var(--signal-fault))',
          }}
        >
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <Field label="Display name (wordmark)" hint="Shown in the PWA header. Leave blank to use the org name.">
            <TextInput
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={org.name}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Primary color" hint="Brand accent — buttons, LEDs, nameplate rail.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={primary}
                  onChange={(e) => setPrimary(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border border-line bg-transparent"
                />
                <TextInput
                  value={primary}
                  onChange={(e) => setPrimary(e.target.value)}
                  className="flex-1 font-mono"
                  pattern="^#[0-9A-Fa-f]{6}$"
                />
              </div>
            </Field>
            <Field label="On-primary" hint="Text color on primary. White for dark primaries.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={onPrimary}
                  onChange={(e) => setOnPrimary(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border border-line bg-transparent"
                />
                <TextInput
                  value={onPrimary}
                  onChange={(e) => setOnPrimary(e.target.value)}
                  className="flex-1 font-mono"
                  pattern="^#[0-9A-Fa-f]{6}$"
                />
              </div>
            </Field>
          </div>

          <Field label="Logo (wordmark image)" hint="PNG or SVG. Transparent background recommended. Max 2 MB.">
            <div className="flex items-center gap-3">
              <label
                className={`flex cursor-pointer items-center gap-2 rounded border border-line bg-surface-inset px-3 py-2 text-sm transition hover:border-line-strong ${
                  uploading ? 'opacity-50' : ''
                }`}
              >
                <Upload size={14} strokeWidth={2} />
                {uploading ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                <input
                  type="file"
                  accept="image/png,image/svg+xml,image/webp,image/jpeg"
                  onChange={onLogoPicked}
                  className="hidden"
                  disabled={uploading}
                />
              </label>
              {logoUrl && (
                <button
                  type="button"
                  onClick={clearLogo}
                  className="text-xs text-signal-fault hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
          </Field>

          <div className="flex justify-end">
            <PrimaryButton onClick={save} disabled={saving || uploading}>
              {saving ? 'Saving…' : 'Save branding'}
            </PrimaryButton>
          </div>
        </div>

        {/* Preview panel — miniature PWA nameplate with this brand applied */}
        <div>
          <p className="caption mb-2">Preview</p>
          <div
            className="relative overflow-hidden rounded-lg border p-5"
            style={{
              background:
                'linear-gradient(180deg, rgb(var(--surface-plate-top)) 0%, rgb(var(--surface-plate-bottom)) 100%)',
              borderColor: 'rgb(var(--surface-plate-edge))',
              boxShadow: 'var(--shadow-plate)',
            }}
          >
            <span
              className="absolute left-0 top-0 bottom-0 w-[3px]"
              style={{ background: primary }}
            />
            <span
              className="absolute top-[-40%] right-[-20%] h-[140%] w-[60%] opacity-35"
              style={{
                background: `radial-gradient(ellipse at center, ${primary}40, transparent 70%)`,
                pointerEvents: 'none',
              }}
            />
            <div className="relative flex items-center gap-2.5">
              <div
                className="flex h-9 w-9 items-center justify-center rounded font-mono text-xs font-bold"
                style={{
                  background: logoUrl ? 'transparent' : primary,
                  color: onPrimary,
                  overflow: 'hidden',
                }}
              >
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt=""
                    style={{ maxHeight: 28, maxWidth: 32, objectFit: 'contain' }}
                  />
                ) : (
                  previewInitials
                )}
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold">{displayedName}</span>
                <span
                  className="font-mono text-[10px] uppercase tracking-widest"
                  style={{ color: 'rgb(var(--ink-tertiary))' }}
                >
                  Equipment hub
                </span>
              </div>
            </div>
            <div className="relative mt-4 flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: primary, boxShadow: `0 0 10px ${primary}90` }}
              />
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-tertiary">
                Sample site · Operational
              </span>
            </div>
            <div className="relative mt-2 text-[22px] font-semibold leading-tight">
              Sample equipment
            </div>
            <div className="relative mt-1 font-mono text-xs text-ink-secondary">
              S/N <span style={{ color: primary, fontWeight: 500 }}>SAMPLE-001</span>
            </div>
            <button
              type="button"
              className="relative mt-4 flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold"
              style={{
                background: primary,
                color: onPrimary,
                boxShadow: `0 6px 16px ${primary}30`,
              }}
            >
              Scan equipment
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function NewSiteForm({ orgId, onCreated }: { orgId: string; onCreated: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [country, setCountry] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        timezone,
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
      <Field label="Site name" required>
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Memphis DC 3"
          required
        />
      </Field>
      <Field label="Site code" hint="Short identifier used on the floor / in CSVs.">
        <TextInput
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="MEM-DC-3"
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="City">
          <TextInput value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Region / state">
          <TextInput value={region} onChange={(e) => setRegion(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Country" hint="ISO-3166 alpha-2, e.g. US">
          <TextInput
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            maxLength={2}
          />
        </Field>
        <Field label="Postal code">
          <TextInput value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        </Field>
      </div>
      <Field label="Timezone" hint="IANA tz, e.g. America/Chicago">
        <TextInput
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="America/Chicago"
        />
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create site'}
        </PrimaryButton>
      </div>
    </form>
  );
}
