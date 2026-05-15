'use client';

import { use, useEffect, useState } from 'react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { PageHeader } from '@/components/page-shell';
import { ErrorBanner } from '@/components/form';
import { BrandingSection } from '@/components/branding-section';
import { PrivacySection } from '@/components/privacy-section';
import { listOrganizations, type AdminOrganization } from '@/lib/api';

export default function OrgSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const orgs = await listOrganizations();
      setOrg(orgs.find((o) => o.id === orgId) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (error) return <ErrorBanner error={error} />;
  if (!org)
    return <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>;

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org.name, href: `/orgs/${orgId}` },
            { label: 'Settings' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Settings"
          description="Customer-level configuration. Branding shows up on the PWA when techs scan equipment; privacy controls whether the PWA opens for unscanned URLs."
        />

        {org.type === 'oem' && <BrandingSection org={org} onChanged={refresh} />}
        <PrivacySection org={org} onChanged={refresh} />
      </div>
    </>
  );
}
