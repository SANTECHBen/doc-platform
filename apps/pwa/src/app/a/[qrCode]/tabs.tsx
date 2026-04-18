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
    <div className="flex flex-col gap-5">
      <nav className="segbar" role="tablist">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              data-active={isActive}
              onClick={() => setActive(t.key)}
              className="segbar-item"
            >
              <Icon size={16} strokeWidth={isActive ? 2 : 1.75} />
              <span className="hidden sm:inline">{t.label}</span>
              {countFor(hub, t.key) !== null && (
                <span className="segbar-count tabular-nums">{countFor(hub, t.key)}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div key={active} className="tab-pane">
        {active === 'overview' ? (
          <div className="spec-panel">
            <OverviewSpecs hub={hub} openIssueCount={openIssueCount} />
            <IssuesPanel
              assetInstanceId={hub.assetInstance.id}
              onCountChange={setOpenIssueCount}
            />
          </div>
        ) : (
          <section className="rounded-md border border-line bg-surface-raised p-5 md:p-7 lg:p-8">
            {active === 'docs' && (
              <DocsTab versionId={hub.pinnedContentPackVersion?.id ?? null} />
            )}
            {active === 'training' && <TrainingTab hub={hub} />}
            {active === 'parts' && <PartsTab assetModelId={hub.assetModel.id} />}
            {active === 'chat' && <ChatTab hub={hub} qrCode={qrCode} />}
          </section>
        )}
      </div>
    </div>
  );
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
        value={
          hub.assetInstance.installedAt
            ? new Date(hub.assetInstance.installedAt).toLocaleDateString()
            : '—'
        }
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
