'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { Field, GhostButton, SecondaryButton, Select, TextInput } from '@/components/form';
import {
  downloadAuditCsv,
  getAuditFacets,
  listAuditEvents,
  verifyAuditChain,
  type AdminAuditEvent,
  type AuditFacets,
  type AuditQuery,
  type AuditVerifyResult,
} from '@/lib/api';

const PAGE_SIZE = 50;

interface Filters {
  q: string;
  eventType: string;
  actorUserId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { q: '', eventType: '', actorUserId: '', from: '', to: '' };

export function AuditView({ orgId }: { orgId?: string }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');

  const [rows, setRows] = useState<AdminAuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Guards against out-of-order responses when filters change quickly.
  const reqSeq = useRef(0);

  // Debounce the free-text box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 350);
    return () => clearTimeout(t);
  }, [filters.q]);

  const buildQuery = useCallback(
    (cursor?: number): AuditQuery => {
      const query: AuditQuery = { limit: PAGE_SIZE };
      if (orgId) query.organizationId = orgId;
      if (debouncedQ) query.q = debouncedQ;
      if (filters.eventType) query.eventType = filters.eventType;
      if (filters.actorUserId) query.actorUserId = filters.actorUserId;
      if (filters.from) query.from = `${filters.from}T00:00:00.000Z`;
      if (filters.to) query.to = `${filters.to}T23:59:59.999Z`;
      if (cursor !== undefined) query.cursor = cursor;
      return query;
    },
    [orgId, debouncedQ, filters.eventType, filters.actorUserId, filters.from, filters.to],
  );

  // (Re)load the first page whenever a filter changes.
  useEffect(() => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    listAuditEvents(buildQuery())
      .then((page) => {
        if (reqSeq.current !== seq) return; // a newer request superseded us
        setRows(page.rows);
        setNextCursor(page.nextCursor);
      })
      .catch((e) => {
        if (reqSeq.current !== seq) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (reqSeq.current === seq) setLoading(false);
      });
  }, [buildQuery]);

  // Facets + integrity check load once per org context.
  const runVerify = useCallback(() => {
    setVerifying(true);
    verifyAuditChain(orgId)
      .then(setVerify)
      .catch(() => setVerify(null))
      .finally(() => setVerifying(false));
  }, [orgId]);

  useEffect(() => {
    getAuditFacets()
      .then(setFacets)
      .catch(() => setFacets(null));
    runVerify();
  }, [runVerify]);

  const loadMore = () => {
    if (nextCursor === null) return;
    const seq = reqSeq.current; // same filter generation
    setLoadingMore(true);
    listAuditEvents(buildQuery(nextCursor))
      .then((page) => {
        if (reqSeq.current !== seq) return;
        setRows((prev) => [...prev, ...page.rows]);
        setNextCursor(page.nextCursor);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMore(false));
  };

  const onExport = () => {
    setExporting(true);
    downloadAuditCsv(buildQuery())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setExporting(false));
  };

  const update = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const anyFilter =
    debouncedQ || filters.eventType || filters.actorUserId || filters.from || filters.to;

  return (
    <PageShell
      crumbs={
        orgId
          ? [{ label: 'Organizations', href: '/orgs' }, { label: 'Audit log' }]
          : [{ label: 'Audit log' }]
      }
    >
      <PageHeader
        title="Audit log"
        description="Append-only, tamper-evident record of meaningful events — QR scans, work-order changes, publishes, sign-ins. Required for safety-critical compliance."
        actions={
          <SecondaryButton onClick={onExport} disabled={exporting}>
            <Download size={15} className="mr-1.5 inline" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </SecondaryButton>
        }
      />

      <IntegrityBanner verify={verify} verifying={verifying} onRecheck={runVerify} />

      {/* Filters */}
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Field label="Search">
          <TextInput
            type="search"
            value={filters.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder="Event, target type, or target ID"
          />
        </Field>
        <Field label="Event type">
          <Select
            value={filters.eventType}
            onChange={(e) => update({ eventType: e.target.value })}
          >
            <option value="">All events</option>
            {(facets?.eventTypes ?? []).map((et) => (
              <option key={et} value={et}>
                {et}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Actor">
          <Select
            value={filters.actorUserId}
            onChange={(e) => update({ actorUserId: e.target.value })}
          >
            <option value="">Anyone</option>
            {(facets?.actors ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <TextInput
              type="date"
              value={filters.from}
              onChange={(e) => update({ from: e.target.value })}
            />
          </Field>
          <Field label="To">
            <TextInput
              type="date"
              value={filters.to}
              onChange={(e) => update({ to: e.target.value })}
            />
          </Field>
        </div>
      </div>
      {anyFilter && (
        <div className="mb-4">
          <GhostButton onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</GhostButton>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-signal-fault/30 bg-signal-fault/10 p-4 text-sm text-signal-fault">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
        <table className="data-table">
          <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Event</th>
              <th className="px-4 py-2">Actor</th>
              {!orgId && <th className="px-4 py-2">Org</th>}
              <th className="px-4 py-2">Target</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2">Payload</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
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
                {!orgId && <td className="px-4 py-3 text-ink-secondary">{e.organization}</td>}
                <td className="px-4 py-3 font-mono text-xs text-ink-secondary">
                  {e.targetType}
                  {e.targetId && (
                    <span className="ml-1 text-ink-tertiary">{e.targetId.slice(0, 8)}</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-ink-tertiary">
                  {e.ipAddress ?? '—'}
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
                      {e.requestId && (
                        <div className="mt-1 text-[10px] text-ink-tertiary">req {e.requestId}</div>
                      )}
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={orgId ? 6 : 7} className="px-4 py-6 text-center text-ink-tertiary">
                  {anyFilter ? 'No events match your filters.' : 'No events recorded yet.'}
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={orgId ? 6 : 7} className="px-4 py-10 text-center text-ink-tertiary">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor !== null && (
        <div className="mt-4 flex justify-center">
          <SecondaryButton onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </SecondaryButton>
        </div>
      )}
    </PageShell>
  );
}

function IntegrityBanner({
  verify,
  verifying,
  onRecheck,
}: {
  verify: AuditVerifyResult | null;
  verifying: boolean;
  onRecheck: () => void;
}) {
  const intact = verify?.ok === true;
  const broken = verify && verify.ok === false;
  return (
    <div
      className={`mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm ${
        broken
          ? 'border-signal-fault/40 bg-signal-fault/10 text-signal-fault'
          : 'border-line-subtle bg-surface-inset text-ink-secondary'
      }`}
    >
      <div className="flex items-center gap-2">
        {broken ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
        {verifying ? (
          <span>Verifying hash-chain integrity…</span>
        ) : intact ? (
          <span>
            Hash chain intact — {verify?.checked ?? 0} org{verify?.checked === 1 ? '' : 's'} verified.
            This log is append-only and tamper-evident.
          </span>
        ) : broken ? (
          <span>
            Integrity check FAILED — {verify?.breaks.length} break
            {verify?.breaks.length === 1 ? '' : 's'} detected (e.g. seq {verify?.breaks[0]?.seq}:{' '}
            {verify?.breaks[0]?.reason}). The log may have been tampered with.
          </span>
        ) : (
          <span>Integrity status unavailable.</span>
        )}
      </div>
      <GhostButton onClick={onRecheck} disabled={verifying}>
        <RefreshCw size={14} className="mr-1.5 inline" />
        Re-check
      </GhostButton>
    </div>
  );
}

export default function AuditPage() {
  return <AuditView />;
}

function eventTone(
  eventType: string,
): 'default' | 'success' | 'warning' | 'danger' | 'info' {
  if (eventType.startsWith('auth.') && eventType.includes('rejected')) return 'danger';
  if (eventType.includes('deleted') || eventType.includes('abandoned')) return 'danger';
  if (eventType.startsWith('work_order')) return 'warning';
  if (eventType === 'qr.scan.blocked') return 'warning';
  if (eventType.startsWith('qr.scan') || eventType === 'asset.hub.viewed') return 'info';
  if (eventType.includes('published') || eventType.includes('finished')) return 'success';
  if (eventType.startsWith('audit.')) return 'info';
  return 'default';
}
