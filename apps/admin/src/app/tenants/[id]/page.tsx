// Legacy /tenants/[id] detail — redirected to the new org workspace.
// The original page (~700 lines covering branding/privacy/sites/setup
// status) has been split into:
//   - apps/admin/src/app/orgs/[id]/page.tsx       (overview + sites)
//   - apps/admin/src/app/orgs/[id]/settings/page.tsx (branding/privacy)
//   - apps/admin/src/components/branding-section.tsx (extracted)
//   - apps/admin/src/components/privacy-section.tsx  (extracted)
// Bookmarks to /tenants/[id] still land in the right place.

import { redirect } from 'next/navigation';

export default async function LegacyTenantDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/orgs/${id}`);
}
