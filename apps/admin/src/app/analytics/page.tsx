'use client';

// Beta analytics dashboard. SANTECH-internal view of activation, usage, and
// feedback metrics across all (or one) tenant. Powers weekly check-ins with
// beta participants and the day-90 conversion conversation.

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ClipboardCheck,
  Eye,
  MessageSquarePlus,
  PackageCheck,
  QrCode,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { PageHeader, PageShell } from '@/components/page-shell';
import {
  getAnalytics,
  listOrganizations,
  type AdminAnalytics,
  type AdminOrganization,
} from '@/lib/api';

const WINDOW_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

export default function AnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const [orgId, setOrgId] = useState<string>('');
  const [orgs, setOrgs] = useState<AdminOrganization[] | null>(null);
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listOrganizations()
      .then(setOrgs)
      .catch((e) => console.error('listOrganizations', e));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getAnalytics({ days, orgId: orgId || undefined })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [days, orgId]);

  return (
    <PageShell crumbs={[{ label: 'Analytics' }]}>
      <PageHeader
        title="Beta analytics"
        description="Usage and engagement metrics across the platform. Use this for weekly beta check-ins and to track activation against program targets."
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-line bg-surface-raised p-0.5">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setDays(opt.days)}
              className={`rounded-sm px-3 py-1.5 text-sm transition ${
                days === opt.days
                  ? 'bg-brand text-brand-ink'
                  : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <select
          value={orgId}
          onChange={(e) => setOrgId(e.target.value)}
          className="rounded border border-line bg-surface-raised px-3 py-1.5 text-sm"
        >
          <option value="">All organizations</option>
          {(orgs ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>

        {loading && (
          <span className="text-xs text-ink-tertiary">Loading…</span>
        )}
      </div>

      {error && (
        <div className="mb-5 rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
          {error}
        </div>
      )}

      {data && (
        <>
          <h2 className="caption mb-2">Engagement</h2>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={<QrCode size={16} />}
              label="QR scans"
              value={data.scans}
              hint={`${data.hubViews} direct hub views, ${data.blockedScans} blocked`}
            />
            <StatCard
              icon={<PackageCheck size={16} />}
              label="Active assets"
              value={data.activeAssets}
              hint="Distinct assets with at least one scan"
            />
            <StatCard
              icon={<Activity size={16} />}
              label="Sparkline"
              value={total(data.scansByDay)}
              hint={renderSparkline(data.scansByDay)}
            />
            <StatCard
              icon={<MessageSquarePlus size={16} />}
              label="Feedback"
              value={data.feedbackSubmissions}
              hint="From the in-app widget"
            />
          </div>

          <h2 className="caption mb-2">Operations</h2>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={<Wrench size={16} />}
              label="Work orders opened"
              value={data.workOrdersOpened}
              hint={`${data.workOrdersStatusChanges} status changes`}
            />
            <StatCard
              icon={<ClipboardCheck size={16} />}
              label="Procedure runs started"
              value={data.procedureRunsStarted}
              hint={`${data.procedureRunsFinished} finished, ${data.procedureRunsAbandoned} abandoned`}
            />
            <StatCard
              icon={<Eye size={16} />}
              label="Sections created"
              value={data.sectionsCreated}
              hint={`${data.contentPacksPublished} content packs published`}
            />
            <StatCard
              icon={<Sparkles size={16} />}
              label="AI chat messages"
              value={data.aiChatMessages ?? '—'}
              hint={
                data.aiChatMessages == null
                  ? 'Not instrumented yet'
                  : 'Total RAG queries this window'
              }
            />
          </div>

          <h2 className="caption mb-2">Daily scan trend</h2>
          <DailyScanTable rows={data.scansByDay} />
        </>
      )}
    </PageShell>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  hint: string | React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-line-subtle bg-surface-raised p-4">
      <div className="mb-1.5 flex items-center gap-2 text-xs uppercase tracking-wide text-ink-tertiary">
        {icon}
        {label}
      </div>
      <div className="font-mono text-2xl tabular-nums text-ink-primary">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="mt-1 text-xs text-ink-tertiary">{hint}</div>
    </div>
  );
}

function total(rows: Array<{ count: number }>): number {
  return rows.reduce((s, r) => s + r.count, 0);
}

function renderSparkline(rows: Array<{ day: string; count: number }>): React.ReactNode {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <span className="mt-1 inline-flex items-end gap-[2px]">
      {rows.map((r) => (
        <span
          key={r.day}
          title={`${r.day}: ${r.count}`}
          className="inline-block w-[3px] rounded-sm bg-brand/70"
          style={{ height: `${4 + (r.count / max) * 20}px` }}
        />
      ))}
    </span>
  );
}

function DailyScanTable({ rows }: { rows: Array<{ day: string; count: number }> }) {
  const recent = useMemo(() => rows.slice(-14).reverse(), [rows]);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
      <table className="data-table">
        <thead className="bg-surface-inset text-left text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            <th className="px-4 py-2">Day</th>
            <th className="px-4 py-2 text-right">Scans</th>
            <th className="w-full px-4 py-2">Volume</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((r) => (
            <tr key={r.day} className="border-t border-line-subtle">
              <td className="px-4 py-2 font-mono text-xs text-ink-secondary">{r.day}</td>
              <td className="px-4 py-2 text-right font-mono text-sm tabular-nums text-ink-primary">
                {r.count}
              </td>
              <td className="px-4 py-2">
                <div className="h-2 w-full rounded bg-surface-inset">
                  <div
                    className="h-2 rounded bg-brand/70"
                    style={{ width: `${(r.count / max) * 100}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
          {recent.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-6 text-center text-ink-tertiary">
                No data yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Suppress unused-import warnings for icons referenced via JSX above.
const _ = [AlertTriangle, ShieldAlert];
