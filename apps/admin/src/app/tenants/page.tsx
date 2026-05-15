// Legacy /tenants list — redirected to the new /orgs picker after the
// workspace refactor. Bookmarks to /tenants resolve to the new home.
// The original page implementation lived here; it's superseded by
// apps/admin/src/app/orgs/page.tsx.

import { redirect } from 'next/navigation';

export default function LegacyTenantsRedirect() {
  redirect('/orgs');
}
