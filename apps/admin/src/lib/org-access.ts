// Central server-side gate for /orgs/[id]/* routes.
//
// Every org-scoped page or layout MUST call requireOrgAccess(id) before
// rendering any org data. The check delegates to the API:
//   GET /admin/organizations/:id/summary
// which already enforces requireOrgInScope() server-side. The API returns
// 404 (intentionally — not 403) when the user lacks access. We translate
// the null result into Next.js notFound() so the user sees a generic 404
// page and the URL doesn't leak whether the org id exists.
//
// Returning the OrganizationSummary lets each page reuse the data it just
// paid for (org name, type, counts) without a second round-trip — most
// org-scoped pages need to render the org name in the header and use the
// type / counts to drive what's shown.

import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getOrgSummaryServer } from './api-server';
import type { OrganizationSummary } from './api';

export interface OrgGuardResult {
  summary: OrganizationSummary;
}

export async function requireOrgAccess(orgId: string): Promise<OrgGuardResult> {
  // Belt-and-suspenders: middleware already redirects unauthenticated
  // requests, but if anyone ever bypasses middleware (direct internal
  // import, a future RSC streaming path, etc.), force the same outcome
  // here so an unauthenticated user can never see org-scoped content.
  const session = await auth();
  if (!session) {
    redirect('/sign-in');
  }
  const summary = await getOrgSummaryServer(orgId);
  if (!summary) {
    // 404 not 403: the API already returned 404 either because the org
    // doesn't exist or the user lacks scope. Don't expose which.
    notFound();
  }
  return { summary };
}
