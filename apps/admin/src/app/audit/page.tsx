'use client';

import { useMemo, useState } from 'react';
import { DataLoader, PageHeader, PageShell, Pill } from '@/components/page-shell';
import { listAuditEvents, type AdminAuditEvent } from '@/lib/api';

export default function AuditPage() {
  const [query, setQuery] = useState('');

  return (
    <PageShell crumbs={[{ label: 'Audit log' }]}>
      <PageHeader
        title="Audit log"
        description="Append-only record of meaningful events — QR scans, work order changes, publishes. Required for safety-critical compliance. Most recent 200 entries."
      />
      <DataLoader load={listAuditEvents} empty={(d) => d.length === 0} deps={[]}>
        {(rows) => {
          const filtered = filter(rows, query);
          return (
            <>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by event type, actor, or target"
                className="mb-4 w-full rounded border border-line bg-surface-raised px-3 py-2 text-sm md:max-w-md"
              />
              <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
                <table className="data-table">
                  <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
                    <tr>
                      <th className="px-4 py-2">When</th>
                      <th className="px-4 py-2">Event</th>
                      <th className="px-4 py-2">Actor</th>
                      <th className="px-4 py-2">Org</th>
                      <th className="px-4 py-2">Target</th>
                      <th className="px-4 py-2">Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => (
                      <tr key={e.id} className="border-t border-line-subtle align-top">
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-ink-secondary">
                          {new Date(e.occurredAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <Pill tone={eventTone(e.eventType)}>{e.eventType}</Pill>
                        </td>
                        <td className="px-4 py-3 text-ink-secondary">
                          {e.actor ?? <span className="text-ink-tertiary">system</span>}
                        </td>
                        <td className="px-4 py-3 text-ink-secondary">{e.organization}</td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                          {e.targetType}
                          {e.targetId && (
                            <span className="ml-1 text-ink-tertiary">
                              {e.targetId.slice(0, 8)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                          {Object.keys(e.payload).length === 0 ? (
                            '—'
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-ink-tertiary">
                                {Object.keys(e.payload).length} field
                                {Object.keys(e.payload).length === 1 ? '' : 's'}
                              </summary>
                              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
                                {JSON.stringify(e.payload, null, 2)}
                              </pre>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-ink-tertiary">
                          No events match your search.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </DataLoader>
    </PageShell>
  );
}

function filter(rows: AdminAuditEvent[], query: string): AdminAuditEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.eventType, r.targetType, r.targetId, r.actor, r.organization]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q),
  );
}

function eventTone(
  eventType: string,
): 'default' | 'success' | 'warning' | 'danger' | 'info' {
  if (eventType.startsWith('work_order')) return 'warning';
  if (eventType.startsWith('qr.scan')) return 'info';
  if (eventType.includes('published')) return 'success';
  return 'default';
}
