'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { PageHeader } from '@/components/page-shell';
import { ErrorBanner } from '@/components/form';
import {
  listAdminTrainingModules,
  listOrganizations,
  type AdminTrainingModule,
  type AdminOrganization,
} from '@/lib/api';

export default function OrgTrainingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [modules, setModules] = useState<AdminTrainingModule[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAdminTrainingModules(), listOrganizations()])
      .then(([m, orgs]) => {
        if (cancelled) return;
        setModules(m);
        setOrg(orgs.find((o) => o.id === orgId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Training modules are scoped via their content pack, which is owned
  // by an org. The list endpoint already filters to user scope. We
  // surface every module the API returns; v1 shows everything in scope
  // and adds an org-name pill so you can spot cross-org modules.
  const rows = modules ?? [];

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Training' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Training modules"
          description="Assessable training units inside content pack versions. Build modules with lessons and activities; assign technicians via enrollments."
        />
        <ErrorBanner error={error} />
        {modules === null ? (
          <TableSkeleton cols={4} rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title="No training modules yet"
            description="Add a training module from inside a content pack version. The page is per-pack today; this list aggregates across packs in your scope."
            action={
              <Link
                href={`/orgs/${orgId}/content-packs`}
                className="btn btn-secondary"
              >
                Open content packs
              </Link>
            }
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Module</th>
                  <th className="px-4 py-2">Asset model</th>
                  <th className="px-4 py-2">Pack</th>
                  <th className="px-4 py-2">Enrollments</th>
                  <th className="px-4 py-2">Completed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3">
                      <Link
                        href={`/orgs/${orgId}/training/${m.id}`}
                        className="font-medium text-ink-primary hover:text-brand"
                      >
                        {m.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">{m.assetModel}</td>
                    <td className="px-4 py-3 text-ink-secondary">{m.contentPack}</td>
                    <td className="px-4 py-3 tnum">{m.enrollments}</td>
                    <td className="px-4 py-3 tnum">{m.completed}</td>
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
