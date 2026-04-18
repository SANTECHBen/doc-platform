'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Paperclip } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import {
  listAdminWorkOrders,
  updateWorkOrder,
  type AdminWorkOrder,
} from '@/lib/api';

type Filter = 'open' | 'closed' | 'all';

const STATUS_OPTIONS: AdminWorkOrder['status'][] = [
  'open',
  'acknowledged',
  'in_progress',
  'blocked',
  'resolved',
  'closed',
];

export default function WorkOrdersPage() {
  const [rows, setRows] = useState<AdminWorkOrder[] | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  async function refresh(f: Filter = filter) {
    try {
      setRows(null);
      setRows(await listAdminWorkOrders(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function onStatusChange(id: string, status: AdminWorkOrder['status']) {
    try {
      await updateWorkOrder(id, { status });
      toast.success(`Status updated`, `Now ${status.replace('_', ' ')}`);
      await refresh(filter);
    } catch (e) {
      toast.error('Update failed', e instanceof Error ? e.message : String(e));
    }
  }

  const openCount = rows?.filter((r) =>
    ['open', 'acknowledged', 'in_progress', 'blocked'].includes(r.status),
  ).length;

  return (
    <PageShell crumbs={[{ label: 'Work orders' }]}>
      <PageHeader
        title="Work orders"
        description="Reported issues from technicians on the floor. Status changes sync back to the PWA immediately."
        actions={
          <div className="flex rounded border border-line bg-surface-raised p-0.5 text-xs">
            {(['open', 'closed', 'all'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-3 py-1.5 capitalize transition ${
                  filter === f
                    ? 'bg-brand text-brand-ink'
                    : 'text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        }
      />
      {error && (
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'rgba(var(--signal-fault) / 0.3)',
            background: 'rgba(var(--signal-fault) / 0.1)',
            color: 'rgb(var(--signal-fault))',
          }}
        >
          {error}
        </div>
      )}

      {!rows ? (
        <p className="p-6 text-center text-sm text-ink-tertiary">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised py-16 text-center">
          <CheckCircle2 size={32} className="text-signal-ok" strokeWidth={1.5} />
          <p className="text-ink-secondary">
            {filter === 'open'
              ? 'No open work orders. Equipment is running clean.'
              : filter === 'closed'
              ? 'No closed work orders in this view.'
              : 'No work orders at all yet.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {openCount !== undefined && filter === 'open' && openCount > 0 && (
            <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
              <AlertTriangle size={14} className="text-signal-warn" strokeWidth={2} />
              {openCount} awaiting resolution
            </p>
          )}
          {rows.map((w) => (
            <article
              key={w.id}
              className="rounded-md border border-line-subtle bg-surface-raised p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`led ${severityLed(w.severity)}`} />
                    <h3 className="text-base font-medium">{w.title}</h3>
                    <SeverityPill severity={w.severity} />
                  </div>
                  {w.description && (
                    <p className="mb-3 text-sm text-ink-secondary">{w.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-ink-tertiary">
                    <span>
                      <span className="caption" style={{ letterSpacing: '0.08em' }}>
                        Asset
                      </span>{' '}
                      <span className="text-ink-primary">{w.assetInstance.modelDisplayName}</span>{' '}
                      <span className="text-brand">{w.assetInstance.serialNumber}</span>
                    </span>
                    <span>
                      <span className="caption" style={{ letterSpacing: '0.08em' }}>
                        Site
                      </span>{' '}
                      <span className="text-ink-primary">{w.assetInstance.siteName}</span>
                    </span>
                    <span>
                      <span className="caption" style={{ letterSpacing: '0.08em' }}>
                        Customer
                      </span>{' '}
                      <span className="text-ink-primary">
                        {w.assetInstance.organizationName}
                      </span>
                    </span>
                  </div>
                  <p className="mt-2 font-mono text-xs text-ink-tertiary">
                    Opened by {w.openedBy?.displayName ?? 'Unknown'} ·{' '}
                    {new Date(w.openedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <StatusSelect
                    current={w.status}
                    onChange={(s) => onStatusChange(w.id, s)}
                  />
                </div>
              </div>
              {w.attachments.length > 0 && (
                <div className="mt-4 flex gap-2 overflow-x-auto">
                  {w.attachments.map((a, i) => (
                    <a
                      key={a.key}
                      href={(a as unknown as { url: string }).url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0"
                      title={a.caption ?? `Attachment ${i + 1}`}
                    >
                      {a.mime.startsWith('image/') ? (
                        <img
                          src={(a as unknown as { url: string }).url}
                          alt=""
                          className="h-20 w-20 rounded object-cover"
                          style={{ border: '1px solid rgb(var(--line))' }}
                        />
                      ) : (
                        <div className="flex h-20 w-20 items-center justify-center rounded border border-line bg-surface-inset text-ink-tertiary">
                          <Paperclip size={18} />
                        </div>
                      )}
                    </a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </PageShell>
  );
}

function SeverityPill({ severity }: { severity: AdminWorkOrder['severity'] }) {
  const tone =
    severity === 'critical'
      ? 'danger'
      : severity === 'high'
      ? 'warning'
      : severity === 'medium'
      ? 'info'
      : 'default';
  return <Pill tone={tone as any}>{severity}</Pill>;
}

function StatusSelect({
  current,
  onChange,
}: {
  current: AdminWorkOrder['status'];
  onChange: (s: AdminWorkOrder['status']) => void;
}) {
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value as AdminWorkOrder['status'])}
      className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-ink-primary"
    >
      {STATUS_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {s.replace('_', ' ')}
        </option>
      ))}
    </select>
  );
}

function severityLed(s: AdminWorkOrder['severity']): string {
  switch (s) {
    case 'critical':
      return 'led-fault';
    case 'high':
    case 'medium':
      return 'led-warn';
    default:
      return 'led-idle';
  }
}
