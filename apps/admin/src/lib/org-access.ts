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
//
// Three outcomes, deliberately distinguished:
//   - ok           → summary loaded; render normally.
//   - notFound()   → org missing OR no access (the API 404'd); generic 404.
//   - unreachable  → the API was briefly unreachable from THIS server (a
//                    transient Vercel→Fly network blip). We do NOT 500 — we
//                    signal the layout to render a client-side fallback that
//                    loads from the browser (a different, healthy network
//                    path). Access stays enforced: every API endpoint runs
//                    requireOrgInScope, and the client fetch 404s for an
//                    unauthorized user just as the server one would.

import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getOrgSummaryServer, ApiUnreachableError } from './api-server';
import type { OrganizationSummary } from './api';

export type OrgGuardResult =
  | { status: 'ok'; summary: OrganizationSummary }
  | { status: 'unreachable' };

export async function requireOrgAccess(orgId: string): Promise<OrgGuardResult> {
  // Belt-and-suspenders: middleware already redirects unauthenticated
  // requests, but if anyone ever bypasses middleware (direct internal
  // import, a future RSC streaming path, etc.), force the same outcome
  // here so an unauthenticated user can never see org-scoped content.
  const session = await auth();
  if (!session) {
    redirect('/sign-in');
  }

  let summary: OrganizationSummary | null;
  try {
    summary = await getOrgSummaryServer(orgId);
  } catch (err) {
    // API briefly unreachable from this server — let the caller fall back to
    // client-side rendering rather than crashing the page with a 500.
    if (err instanceof ApiUnreachableError) {
      return { status: 'unreachable' };
    }
    // Anything else is unexpected — surface it.
    throw err;
  }

  // notFound() throws a Next control-flow signal; keep it OUTSIDE the try
  // above so it's never swallowed by the catch.
  if (!summary) {
    // 404 not 403: the API already returned 404 either because the org
    // doesn't exist or the user lacks scope. Don't expose which.
    notFound();
  }

  return { status: 'ok', summary };
}
