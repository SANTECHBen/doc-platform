'use client';

// Reusable branding editor for an organization. Lifted out of
// /tenants/[id]/page.tsx so both the legacy detail page and the new
// /orgs/[id]/settings page can render the same component.
//
// Behavior unchanged from the original: upload logo, pick primary +
// on-primary colors, optional display-name override, save via API.
// Live preview shows what techs see in the PWA after a QR scan.

import { useState } from 'react';
import { Palette, Upload } from 'lucide-react';
import { ErrorBanner, Field, PrimaryButton, TextInput } from './form';
import { useToast } from './toast';
import {
  uploadFile,
  updateOrgBranding,
  type AdminOrganization,
} from '@/lib/api';

export function BrandingSection({
  org,
  onChanged,
}: {
  org: AdminOrganization;
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
        logoStorageKey,
      });
      toast.success('Branding saved', 'Applied on the next QR scan.');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function clearLogo() {
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
        Applied to the PWA when a technician scans equipment you own. They'll
        see your logo, wordmark, and accent color instead of FieldSupport's
        default brand.
      </p>

      <ErrorBanner error={error} />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <Field
            label="Display name (wordmark)"
            hint="Shown in the PWA header. Leave blank to use the org name."
          >
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

          <Field
            label="Logo (wordmark image)"
            hint="PNG or SVG. Transparent background recommended. Max 2 MB."
          >
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
                  // eslint-disable-next-line @next/next/no-img-element
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
