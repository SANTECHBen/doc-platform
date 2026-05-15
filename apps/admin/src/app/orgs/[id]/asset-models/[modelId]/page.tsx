'use client';

// Org-scoped asset model detail. Wraps the legacy detail editor (which
// is ~1200 lines and unsafe to refactor in one shot) and adds a
// workspace-aware tab strip on top. Tabs scroll to anchored sections
// in the legacy page rather than mounting different trees — that gives
// the admin "open the model, see everything in one place" without
// rebuilding the editor or losing any feature.

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Boxes, FileStack, QrCode, Tag, Wrench } from 'lucide-react';
import LegacyAssetModelDetail from '@/app/asset-models/[id]/page';

const TABS = [
  {
    id: 'overview',
    label: 'Overview',
    icon: Boxes,
    anchor: null,
    description: 'Header, image, and primary actions',
  },
  {
    id: 'instances',
    label: 'Instances',
    icon: Tag,
    anchor: 'instances-section',
    description: 'Serial-numbered units deployed at sites',
  },
  {
    id: 'bom',
    label: 'BOM (Parts)',
    icon: Wrench,
    anchor: 'bom-section',
    description: 'Part list attached to this model',
  },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function OrgAssetModelDetail({
  params,
}: {
  params: Promise<{ id: string; modelId: string }>;
}) {
  const p = use(params);
  const remapped = Promise.resolve({ id: p.modelId });
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // When admin clicks a tab, scroll to its section. Overview = top.
  function go(id: TabId) {
    setActiveTab(id);
    const tab = TABS.find((t) => t.id === id);
    if (!tab?.anchor) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    document.getElementById(tab.anchor)?.scrollIntoView({ behavior: 'smooth' });
  }

  // Track which section is in view (lightweight scroll spy) so the tab
  // strip stays in sync as the admin scrolls manually.
  useEffect(() => {
    const ids = TABS.filter((t) => t.anchor).map((t) => t.anchor!);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const tab = TABS.find((t) => t.anchor === e.target.id);
            if (tab) setActiveTab(tab.id);
          }
        }
      },
      { rootMargin: '-25% 0px -55% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    // Top of page → overview tab
    const onScroll = () => {
      if (window.scrollY < 200) setActiveTab('overview');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [p.modelId]);

  return (
    <>
      {/* Tab strip — sticky below the global TopBar so it stays accessible
          as the admin scrolls through the (long) editor. */}
      <div
        className="sticky z-20 border-b border-line bg-surface-base/95 backdrop-blur-sm"
        style={{ top: 56 }}
      >
        <div className="mx-auto flex max-w-[1440px] items-center gap-1 px-6 py-2 lg:px-10">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => go(t.id)}
                title={t.description}
                className="group flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition"
                style={{
                  background: active ? 'rgb(var(--brand) / 0.12)' : 'transparent',
                  color: active ? 'rgb(var(--brand))' : 'rgb(var(--ink-secondary))',
                }}
              >
                <Icon size={14} strokeWidth={active ? 2 : 1.75} />
                <span>{t.label}</span>
              </button>
            );
          })}
          <span className="ml-3 hidden text-xs text-ink-tertiary md:inline">
            {TABS.find((t) => t.id === activeTab)?.description}
          </span>

          {/* Workspace shortcuts — content packs and QR codes live as
              top-level workspace tabs but are always relevant when
              viewing a specific model. Surface them here for quick
              cross-navigation. */}
          <div className="ml-auto flex items-center gap-1">
            <Link
              href={`/orgs/${p.id}/content-packs`}
              className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-ink-tertiary transition hover:bg-surface-inset hover:text-ink-primary"
            >
              <FileStack size={12} strokeWidth={1.75} />
              Content packs
            </Link>
            <Link
              href={`/orgs/${p.id}/qr-codes`}
              className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium text-ink-tertiary transition hover:bg-surface-inset hover:text-ink-primary"
            >
              <QrCode size={12} strokeWidth={1.75} />
              QR codes
            </Link>
          </div>
        </div>
      </div>

      <LegacyAssetModelDetail params={remapped} />
    </>
  );
}
