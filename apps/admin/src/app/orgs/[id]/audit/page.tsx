'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { TopBar } from '@/components/top-bar';
import { EmptyState } from '@/components/empty-state';
import { TableSkeleton } from '@/components/skeleton';
import { PageHeader } from '@/components/page-shell';
import { ErrorBanner } from '@/components/form';
import {
  listAuditEvents,
  listOrganizations,
  type AdminAuditEvent,
  type AdminOrganization,
} from '@/lib/api';

export default function OrgAuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: orgId } = use(params);
  const [events, setEvents] = useState<AdminAuditEvent[] | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAuditEvents(), listOrganizations()])
      .then(([e, orgs]) => {
        if (cancelled) return;
        setEvents(e);
        setOrg(orgs.find((o) => o.id === orgId) ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const filtered = useMemo(() => {
    const list = (events ?? []).filter((e) => e.organization === orgId);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (e) =>
        e.eventType.toLowerCase().includes(q) ||
        e.targetType.toLowerCase().includes(q) ||
        (e.targetId ?? '').toLowerCase().includes(q),
    );
  }, [events, orgId, query]);

  return (
    <>
      <TopBar>
        <Breadcrumbs
          items={[
            { label: 'Organizations', href: '/orgs' },
            { label: org?.name ?? '…', href: `/orgs/${orgId}` },
            { label: 'Audit log' },
          ]}
        />
      </TopBar>
      <div className="page-enter mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <PageHeader
          title="Audit log"
          description="Append-only record of every change in this organization. Use it to answer 'who did what, when' for compliance and troubleshooting."
        />
        <ErrorBanner error={error} />
        {events === null ? (
          <TableSkeleton cols={4} rows={6} />
        ) : (events ?? []).filter((e) => e.organization === orgId).length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit events yet"
            description="Events appear here as soon as anyone makes a change in this workspace — publishing a content pack, minting a QR code, etc."
          />
        ) : (
          <div className="flex flex-col gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by event type, target type, or target id…"
              className="form-input max-w-md"
              aria-label="Filter audit events"
            />
            <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
              <table className="data-table">
                <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                  <tr>
                    <th className="px-4 py-2">When</th>
                    <th className="px-4 py-2">Event</th>
                    <th className="px-4 py-2">Target</th>
                    <th className="px-4 py-2">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id} className="border-t border-line-subtle align-top">
                      <td className="px-4 py-3 text-xs text-ink-tertiary">
                        {new Date(e.occurredAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-primary">
                        {e.eventType}
                      </td>
                      <td className="px-4 py-3 text-ink-secondary">
                        <div>{e.targetType}</div>
                        {e.targetId && (
                          <div className="font-mono text-xs text-ink-tertiary">
                            {e.targetId}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {e.actor ?? '—'}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-4 py-6 text-center text-sm text-ink-tertiary"
                      >
                        No events match {JSON.stringify(query)}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
