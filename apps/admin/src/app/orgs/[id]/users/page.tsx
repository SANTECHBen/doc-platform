'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { PageHeader, Pill } from '@/components/page-shell';
import { ErrorBanner } from '@/components/form';
import {
  listAdminUsers,
  listOrganizations,
  type AdminUser,
  type AdminOrganization,
} from '@/lib/api';

export default function OrgUsersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAdminUsers(), listOrganizations()])
      .then(([u, orgs]) => {
        if (cancelled) return;
        setUsers(u);
        setOrg(orgs.find((o) => o.id === orgId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Users whose home org is this org. Membership data is not exposed
  // through the current admin user list — this is a near-fit. Adding
  // proper per-org membership listing is a follow-up TODO.
  const filtered = useMemo(
    () => (users ?? []).filter((u) => u.homeOrganization.id === orgId),
    [users, orgId],
  );

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Users' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Users"
          description="People whose home organization is this one. They sign in with Microsoft and inherit access to this org plus any descendants."
        />
        <ErrorBanner error={error} />
        {users === null ? (
          <TableSkeleton cols={4} rows={5} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No users yet"
            description="Users provision themselves automatically the first time they sign in with Microsoft, provided their MS tenant matches one in the allowlist. Share the admin URL to onboard them."
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Roles</th>
                  <th className="px-4 py-2">Memberships</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3 font-medium text-ink-primary">
                      {u.displayName}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                      {u.email}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0
                          ? '—'
                          : u.roles.map((r) => (
                              <Pill key={r}>{r}</Pill>
                            ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 tnum">{u.membershipCount}</td>
                    <td className="px-4 py-3">
                      {u.disabled ? (
                        <span className="text-signal-fault">Disabled</span>
                      ) : (
                        <span className="text-signal-ok">Active</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
