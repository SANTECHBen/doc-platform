'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Building2,
  FileCheck,
  GraduationCap,
  MapPin,
  QrCode,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { PageShell, PageHeader } from '@/components/page-shell';
import { SetupChecklist } from '@/components/setup-checklist';
import { TilesSkeleton } from '@/components/skeleton';
import { getMetrics, type AdminMetrics } from '@/lib/api';

export default function Dashboard() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMetrics()
      .then(setMetrics)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <PageShell crumbs={[{ label: 'Dashboard' }]}>
      <PageHeader
        title="Dashboard"
        description="At-a-glance tenant state. All counts are live from the database."
        actions={
          metrics && (
            <span className="pill pill-outline">
              <span
                className={`led ${metrics.openWorkOrders > 0 ? 'led-warn' : 'led-ok'}`}
              />
              {metrics.openWorkOrders > 0
                ? `${metrics.openWorkOrders} work order${metrics.openWorkOrders === 1 ? '' : 's'} open`
                : 'All systems green'}
            </span>
          )
        }
      />

      {error ? (
        <div
          className="rounded-md border p-4 text-sm"
          style={{
            borderColor: 'rgba(var(--signal-fault) / 0.3)',
            background: 'rgba(var(--signal-fault) / 0.1)',
            color: 'rgb(var(--signal-fault))',
          }}
        >
          {error}
        </div>
      ) : !metrics ? (
        <TilesSkeleton count={8} />
      ) : (
        <div className="flex flex-col gap-5">
          <SetupChecklist metrics={metrics} />
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
          <Tile icon={Building2} label="Organizations" value={metrics.organizations} sub="tenants across all types" />
          <Tile icon={MapPin} label="Sites" value={metrics.sites} sub="customer facilities" />
          <Tile icon={Boxes} label="Instances" value={metrics.assetInstances} sub="serial-numbered units" />
          <Tile icon={QrCode} label="QR labels" value={metrics.activeQrCodes} sub="active in the field" />
          <Tile
            icon={AlertTriangle}
            label="Work orders"
            value={metrics.openWorkOrders}
            tone={metrics.openWorkOrders > 0 ? 'warn' : 'default'}
            sub={metrics.openWorkOrders === 0 ? 'no open issues' : 'awaiting resolution'}
          />
          <Tile
            icon={FileCheck}
            label="Published packs"
            value={metrics.publishedContentPacks}
            sub="available to instances"
          />
          <Tile
            icon={GraduationCap}
            label="Enrollments"
            value={metrics.enrollments}
            sub={`${metrics.completedEnrollments} completed`}
          />
          <Tile
            icon={TrendingUp}
            label="Completion"
            value={`${Math.round(metrics.completionRate * 100)}%`}
            tone={metrics.completionRate >= 0.8 ? 'ok' : 'default'}
            sub={`of ${metrics.enrollments} enrolled`}
          />
          </div>
        </div>
      )}
    </PageShell>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'default' | 'warn' | 'ok' | 'fault';
}) {
  const toneClass =
    tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : tone === 'fault' ? 'fault' : '';
  return (
    <div className="metric-tile">
      <div className="metric-tile-top">
        <span className="cap">{label}</span>
        <Icon size={16} strokeWidth={1.75} className="text-ink-tertiary" />
      </div>
      <div className={`metric-value tnum ${toneClass}`}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}
