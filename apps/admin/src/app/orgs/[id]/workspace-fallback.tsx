'use client';

// Rendered by the org layout when the SERVER couldn't reach the API to load
// the org summary (a transient Vercel→Fly network blip — see org-access.ts).
// The browser reaches the API over a different, healthy network path, so we
// re-fetch the summary client-side and render the real workspace instead of
// showing a 500.
//
// Security: deferring the gate to the client is safe. Every API endpoint
// enforces requireOrgInScope server-side, and the client summary fetch 404s
// for an unauthorized user exactly as the server one would — in which case we
// render the same "not found / no access" copy, never org data.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { OrgSidebar } from '@/components/org-sidebar';
import { getOrganizationSummary, type OrganizationSummary } from '@/lib/api';
import { OrgWorkspaceContextProvider } from './workspace-context';

type LoadState = 'loading' | 'error' | 'denied';

export function WorkspaceFallback({
  orgId,
  userMenu,
  children,
}: {
  orgId: string;
  userMenu?: ReactNode;
  children: ReactNode;
}) {
  const [summary, setSummary] = useState<OrganizationSummary | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    setState('loading');
    try {
      setSummary(await getOrganizationSummary(orgId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // getOrganizationSummary throws `API <status>: ...` on non-2xx.
      // 401/403/404 = genuine no-access / missing; anything else = transient.
      setState(/^API 40[134]/.test(msg) ? 'denied' : 'error');
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (summary) {
    const org = summary.organization;
    return (
      <div className="flex min-h-screen">
        <OrgSidebar
          org={{ id: org.id, name: org.name, type: org.type }}
          userMenu={userMenu}
        />
        <div className="flex min-h-screen flex-1 flex-col">
          <OrgWorkspaceContextProvider summary={summary}>
            <main className="flex-1">{children}</main>
          </OrgWorkspaceContextProvider>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base px-6 py-10">
      <div className="max-w-md text-center">
        {state === 'loading' && (
          <>
            <div
              className="mx-auto mb-4 h-6 w-6 animate-spin rounded-full border-2 border-line border-t-brand"
              aria-hidden
            />
            <p className="text-sm text-ink-secondary">Loading workspace…</p>
          </>
        )}

        {state === 'error' && (
          <>
            <p className="caption mb-2">Connection hiccup</p>
            <h1 className="mb-3 text-2xl font-semibold text-ink-primary">
              Couldn&rsquo;t reach the server
            </h1>
            <p className="mb-6 text-sm text-ink-secondary">
              This is usually momentary and your data is safe. Try again.
            </p>
            <button type="button" onClick={() => void load()} className="btn btn-primary">
              Retry
            </button>
          </>
        )}

        {state === 'denied' && (
          <>
            <p className="caption mb-2">404</p>
            <h1 className="mb-3 text-2xl font-semibold text-ink-primary">
              Workspace not found
            </h1>
            <p className="mb-6 text-sm text-ink-secondary">
              We couldn&rsquo;t find that organization, or you don&rsquo;t have
              access to it.
            </p>
            <Link href="/orgs" className="btn btn-primary">
              ← All organizations
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
