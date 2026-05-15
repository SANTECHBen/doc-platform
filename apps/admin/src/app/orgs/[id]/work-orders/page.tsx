'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { PageHeader, Pill } from '@/components/page-shell';
import { ErrorBanner } from '@/components/form';
import {
  listAdminWorkOrders,
  listOrganizations,
  type AdminWorkOrder,
  type AdminOrganization,
} from '@/lib/api';

const STATUS_TONE: Record<AdminWorkOrder['status'], 'default' | 'warning' | 'success' | 'danger'> = {
  open: 'warning',
  acknowledged: 'warning',
  in_progress: 'warning',
  blocked: 'danger',
  resolved: 'success',
  closed: 'success',
};

const SEVERITY_TONE: Record<AdminWorkOrder['severity'], 'default' | 'warning' | 'danger'> = {
  info: 'default',
  low: 'default',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

export default function OrgWorkOrdersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [statusFilter, setStatusFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [rows, setRows] = useState<AdminWorkOrder[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAdminWorkOrders(statusFilter), listOrganizations()])
      .then(([wo, orgs]) => {
        if (cancelled) return;
        setRows(wo);
        setOrg(orgs.find((o) => o.id === orgId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, statusFilter]);

  // Filter to work orders whose underlying instance lives at a site in
  // this org. The API returns everything in scope (descendants
  // included); we narrow by organization name match.
  // TODO: ask the API for organizationId on work orders so we can match
  // by id instead of name.
  const filtered = useMemo(() => {
    if (!rows || !org) return rows;
    return rows.filter((w) => w.assetInstance.organizationName === org.name);
  }, [rows, org]);

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Work orders' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Work orders"
          description="Field-reported issues. Techs open these from the asset hub when they hit something they can't resolve themselves."
        />
        <ErrorBanner error={error} />
        <div className="mb-3 flex gap-1.5">
          {(['open', 'closed', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`btn btn-sm ${
                statusFilter === s ? 'btn-primary' : 'btn-secondary'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        {rows === null ? (
          <TableSkeleton cols={5} rows={5} />
        ) : (filtered ?? []).length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title={`No ${statusFilter === 'all' ? '' : statusFilter} work orders`}
            description="Field techs will open work orders from inside the PWA when they hit a snag. They'll show up here for triage."
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
            <table className="data-table">
              <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Equipment</th>
                  <th className="px-4 py-2">Site</th>
                  <th className="px-4 py-2">Opened</th>
                </tr>
              </thead>
              <tbody>
                {(filtered ?? []).map((w) => (
                  <tr key={w.id} className="border-t border-line-subtle">
                    <td className="px-4 py-3 font-medium text-ink-primary">
                      {w.title}
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={STATUS_TONE[w.status]}>
                        {w.status.replace('_', ' ')}
                      </Pill>
                    </td>
                    <td className="px-4 py-3">
                      <Pill tone={SEVERITY_TONE[w.severity]}>{w.severity}</Pill>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {w.assetInstance.modelDisplayName}
                      <span className="ml-1 font-mono text-xs text-ink-tertiary">
                        S/N {w.assetInstance.serialNumber}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-secondary">
                      {w.assetInstance.siteName}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-tertiary">
                      {new Date(w.openedAt).toLocaleString()}
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
