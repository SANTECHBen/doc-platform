'use client';

import { DataLoader, PageHeader, PageShell, Pill } from '@/components/page-shell';
import { listAdminUsers } from '@/lib/api';

export default function UsersPage() {
  return (
    <PageShell crumbs={[{ label: 'Users' }]}>
      <PageHeader
        title="Users"
        description="Cross-tenant user directory. Roles are scoped to org memberships; a single user can hold multiple."
      />
      <DataLoader load={listAdminUsers} empty={(d) => d.length === 0} deps={[]}>
        {(rows) => (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Home org</th>
                  <th className="px-4 py-2">Roles</th>
                  <th className="px-4 py-2">Memberships</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className="border-t border-line-subtle align-top">
                    <td className="px-4 py-3 font-medium text-ink-primary">{u.displayName}</td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-secondary">{u.email}</td>
                    <td className="px-4 py-3 text-ink-secondary">{u.homeOrganization.name}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0 ? (
                          <span className="text-xs text-ink-tertiary">none</span>
                        ) : (
                          u.roles.map((r) => (
                            <span
                              key={r}
                              className="rounded bg-surface-inset px-1.5 py-0.5 text-xs capitalize text-ink-secondary"
                            >
                              {r.replace('_', ' ')}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">{u.membershipCount}</td>
                    <td className="px-4 py-3">
                      {u.disabled ? <Pill tone="danger">disabled</Pill> : <Pill tone="success">active</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataLoader>
    </PageShell>
  );
}
