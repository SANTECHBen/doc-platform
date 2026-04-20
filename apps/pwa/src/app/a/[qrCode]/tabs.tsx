'use client';

import { useState } from 'react';
import {
  FileText,
  GraduationCap,
  LayoutGrid,
  MessageSquare,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { AssetHubPayload } from '@/lib/shared-schema';
import { DocsTab } from './docs-tab';
import { ChatTab } from './chat-tab';
import { TrainingTab } from './training-tab';
import { PartsTab } from './parts-tab';
import { IssuesPanel } from './issues-panel';

type TabKey = 'overview' | 'docs' | 'training' | 'parts' | 'chat';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'docs', label: 'Documents', icon: FileText },
  { key: 'training', label: 'Training', icon: GraduationCap },
  { key: 'parts', label: 'Parts', icon: Wrench },
  { key: 'chat', label: 'Assistant', icon: MessageSquare },
];

export function AssetHubTabs({ hub, qrCode }: { hub: AssetHubPayload; qrCode: string }) {
  const [active, setActive] = useState<TabKey>('overview');
  const [openIssueCount, setOpenIssueCount] = useState<number>(
    hub.tabs.openWorkOrders.count,
  );

  return (
    <>
      <div key={active} className="tab-pane flex flex-col gap-4">
        {active === 'overview' ? (
          <div className="spec-panel">
            <OverviewSpecs hub={hub} openIssueCount={openIssueCount} />
            <IssuesPanel
              assetInstanceId={hub.assetInstance.id}
              onCountChange={setOpenIssueCount}
            />
          </div>
        ) : (
          <section className="rounded-md border border-line bg-surface-raised p-4 md:p-6">
            {active === 'docs' && (
              <DocsTab versionId={hub.pinnedContentPackVersion?.id ?? null} />
            )}
            {active === 'training' && <TrainingTab hub={hub} />}
            {active === 'parts' && <PartsTab assetModelId={hub.assetModel.id} />}
            {active === 'chat' && <ChatTab hub={hub} qrCode={qrCode} />}
          </section>
        )}
      </div>

      <nav className="app-tabbar" role="tablist" aria-label="Sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.key;
          const count = countFor(hub, t.key);
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              data-active={isActive}
              onClick={() => setActive(t.key)}
              className="app-tabbar-item"
            >
              <Icon size={22} strokeWidth={isActive ? 2.25 : 1.75} />
              <span>{t.label}</span>
              {count !== null && count > 0 && (
                <span className="app-tabbar-count tabular-nums">{count}</span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}

// UTC + explicit locale so the same markup renders on the server (Fly/Chicago)
// and every client browser. Using toLocaleDateString() without these knobs
// causes React hydration mismatch (#418) when the client's locale/timezone
// differs from the server.
const INSTALLED_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
function formatInstalledAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : INSTALLED_FMT.format(d);
}

function countFor(hub: AssetHubPayload, key: TabKey): number | null {
  switch (key) {
    case 'docs':
      return hub.tabs.docs.count;
    case 'training':
      return hub.tabs.training.count;
    case 'parts':
      return hub.tabs.parts.count;
    default:
      return null;
  }
}

function OverviewSpecs({
  hub,
  openIssueCount,
}: {
  hub: AssetHubPayload;
  openIssueCount: number;
}) {
  return (
    <div className="spec-grid">
      <SpecField label="Model code" value={hub.assetModel.modelCode} mono />
      <SpecField label="Category" value={hub.assetModel.category.toUpperCase()} />
      <SpecField label="Serial" value={hub.assetInstance.serialNumber} mono brand />
      <SpecField label="Site" value={hub.site.name} />
      <SpecField label="Customer" value={hub.organization.name} />
      <SpecField
        label="Content rev"
        value={hub.pinnedContentPackVersion?.versionLabel ?? '—'}
        mono
      />
      <SpecField
        label="Open issues"
        value={String(openIssueCount)}
        mono
        tone={openIssueCount > 0 ? 'warn' : 'ok'}
      />
      <SpecField
        label="Installed"
        value={formatInstalledAt(hub.assetInstance.installedAt)}
      />
    </div>
  );
}

function SpecField({
  label,
  value,
  mono,
  brand,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  brand?: boolean;
  tone?: 'ok' | 'warn' | 'fault';
}) {
  const cls = [
    'val',
    mono && 'mono',
    brand && 'brand',
    tone === 'ok' && 'ok',
    tone === 'warn' && 'warn',
    tone === 'fault' && 'fault',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="spec-field">
      <span className="cap">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}
