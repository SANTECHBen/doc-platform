'use client';

// Reusable privacy + access controls for an organization. Lifted out
// of /tenants/[id]/page.tsx so both the legacy detail page and the new
// /orgs/[id]/settings page can render the same component.

import { useState } from 'react';
import { Field, PrimaryButton, TextInput } from './form';
import { useToast } from './toast';
import { updateOrgPrivacy, type AdminOrganization } from '@/lib/api';

export function PrivacySection({
  org,
  onChanged,
}: {
  org: AdminOrganization;
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenantInput, setTenantInput] = useState(org.msftTenantId ?? '');
  const toast = useToast();

  async function toggleScanAccess() {
    setSaving(true);
    setError(null);
    try {
      await updateOrgPrivacy(org.id, { requireScanAccess: !org.requireScanAccess });
      toast.success(
        !org.requireScanAccess ? 'Scan access required' : 'Scan access disabled',
      );
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveTenant() {
    const trimmed = tenantInput.trim();
    setSaving(true);
    setError(null);
    try {
      await updateOrgPrivacy(org.id, { msftTenantId: trimmed || null });
      toast.success(trimmed ? 'Tenant mapping saved' : 'Tenant mapping cleared');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function clearTenant() {
    setTenantInput('');
    setSaving(true);
    setError(null);
    try {
      await updateOrgPrivacy(org.id, { msftTenantId: null });
      toast.success('Tenant mapping cleared');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const tenantDirty = tenantInput.trim() !== (org.msftTenantId ?? '');

  return (
    <section className="mb-8 rounded-md border border-line bg-surface-raised p-5">
      <h2 className="mb-1 text-sm font-semibold text-ink-primary">
        Privacy & access
      </h2>
      <p className="mb-4 text-xs text-ink-tertiary">
        Controls how the PWA authorizes access and which Microsoft tenant maps
        to this organization for admin sign-in.
      </p>
      {error && (
        <p className="mb-3 rounded border border-signal-fault/40 bg-signal-fault/10 p-2 text-xs text-signal-fault">
          {error}
        </p>
      )}

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={org.requireScanAccess}
          onChange={toggleScanAccess}
          disabled={saving}
          className="mt-1 shrink-0"
        />
        <span className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-primary">
            Require QR scan for PWA access
          </span>
          <span className="text-xs text-ink-tertiary">
            When enabled, technicians must scan the physical QR sticker on the
            equipment before the PWA shows content. An 8-hour session cookie is
            minted at scan time — sharing a URL out-of-band won't grant access
            to anyone without the cookie.
          </span>
        </span>
      </label>

      <div className="mt-6 border-t border-line pt-5">
        <Field
          label="Microsoft tenant ID"
          hint="Paste this customer's Microsoft Entra tenant UUID. Users signing in with that tenant will land in this organization's data scope. Leave empty to unlink."
        >
          <TextInput
            value={tenantInput}
            onChange={(e) => setTenantInput(e.target.value)}
            placeholder="e.g. 05e87997-d8b1-4045-bf3f-7294c964a305"
            disabled={saving}
          />
        </Field>
        <div className="mt-3 flex items-center justify-end gap-2">
          {org.msftTenantId && (
            <button
              type="button"
              onClick={clearTenant}
              disabled={saving}
              className="btn btn-ghost btn-sm text-signal-fault hover:bg-signal-fault/10"
            >
              Unlink
            </button>
          )}
          <PrimaryButton onClick={saveTenant} disabled={saving || !tenantDirty}>
            {saving ? 'Saving…' : 'Save tenant'}
          </PrimaryButton>
        </div>
        <p className="mt-2 text-xs text-ink-tertiary">
          Don't forget to add the tenant to{' '}
          <code className="font-mono">AUTH_ALLOWED_TENANTS</code> on the API
          for the customer's sign-ins to be accepted.
        </p>
      </div>
    </section>
  );
}
