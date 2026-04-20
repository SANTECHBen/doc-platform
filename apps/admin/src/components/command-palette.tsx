'use client';

import {
  Boxes,
  Building2,
  FileStack,
  GraduationCap,
  LayoutDashboard,
  QrCode,
  ScrollText,
  Search,
  Wrench,
  Users,
  CornerDownLeft,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  listAdminAssetModels,
  listAdminUsers,
  listContentPacks,
  listOrganizations,
  listQrCodes,
} from '@/lib/api';

interface Item {
  id: string;
  label: string;
  hint?: string;
  href: string;
  group: string;
  icon: typeof Search;
  keywords: string;
}

// Static navigation items — always present. Dynamic items (orgs, assets, etc.)
// are loaded on open so the palette is fresh every time it's invoked.
const NAV: Item[] = [
  { id: 'nav-dashboard', label: 'Dashboard', href: '/', group: 'Navigate', icon: LayoutDashboard, keywords: 'home overview' },
  { id: 'nav-orgs', label: 'Organizations', href: '/tenants', group: 'Navigate', icon: Building2, keywords: 'tenants oem dealer customer' },
  { id: 'nav-models', label: 'Asset models', href: '/asset-models', group: 'Navigate', icon: Boxes, keywords: 'equipment sku' },
  { id: 'nav-packs', label: 'Content packs', href: '/content-packs', group: 'Navigate', icon: FileStack, keywords: 'documents publish version' },
  { id: 'nav-training', label: 'Training', href: '/training', group: 'Navigate', icon: GraduationCap, keywords: 'modules enrollment quiz' },
  { id: 'nav-parts', label: 'Parts', href: '/parts', group: 'Navigate', icon: Wrench, keywords: 'bom catalog' },
  { id: 'nav-qr', label: 'QR codes', href: '/qr-codes', group: 'Navigate', icon: QrCode, keywords: 'labels stickers print generate mint' },
  { id: 'nav-users', label: 'Users', href: '/users', group: 'Navigate', icon: Users, keywords: 'people roles' },
  { id: 'nav-audit', label: 'Audit log', href: '/audit', group: 'Navigate', icon: ScrollText, keywords: 'events history compliance' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dyn, setDyn] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Hotkey: Cmd+K or Ctrl+K anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // On open: clear state, focus input, fetch dynamic items.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setTimeout(() => inputRef.current?.focus(), 20);

    let cancelled = false;
    Promise.all([
      listOrganizations().catch(() => []),
      listAdminAssetModels().catch(() => []),
      listContentPacks().catch(() => []),
      listQrCodes().catch(() => []),
      listAdminUsers().catch(() => []),
    ]).then(([orgs, models, packs, qrs, users]) => {
      if (cancelled) return;
      const items: Item[] = [
        ...orgs.map((o) => ({
          id: `org-${o.id}`,
          label: o.name,
          hint: `${o.type.replace('_', ' ')} · ${o.slug}`,
          href: `/tenants/${o.id}`,
          group: 'Organizations',
          icon: Building2,
          keywords: `${o.slug} ${o.oemCode ?? ''} ${o.type}`,
        })),
        ...models.map((m) => ({
          id: `model-${m.id}`,
          label: m.displayName,
          hint: `${m.modelCode} · ${m.category} · ${m.owner.name}`,
          href: `/asset-models/${m.id}`,
          group: 'Asset models',
          icon: Boxes,
          keywords: `${m.modelCode} ${m.category} ${m.owner.name}`,
        })),
        ...packs.map((p) => ({
          id: `pack-${p.id}`,
          label: p.name,
          hint: `${p.layerType} · ${p.assetModel.displayName}`,
          href: `/content-packs/${p.id}`,
          group: 'Content packs',
          icon: FileStack,
          keywords: `${p.slug} ${p.layerType} ${p.assetModel.displayName}`,
        })),
        ...qrs.slice(0, 50).map((q) => ({
          id: `qr-${q.id}`,
          label: q.code,
          hint: q.assetInstance
            ? `${q.assetInstance.modelDisplayName} · ${q.assetInstance.serialNumber}`
            : 'Unlinked',
          href: `/qr-codes`,
          group: 'QR codes',
          icon: QrCode,
          keywords: `${q.label ?? ''} ${q.assetInstance?.serialNumber ?? ''}`,
        })),
        ...users.map((u) => ({
          id: `user-${u.id}`,
          label: u.displayName,
          hint: `${u.email} · ${u.homeOrganization.name}`,
          href: `/users`,
          group: 'Users',
          icon: Users,
          keywords: `${u.email} ${u.homeOrganization.name} ${u.roles.join(' ')}`,
        })),
      ];
      setDyn(items);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const items = useMemo(() => [...NAV, ...dyn], [dyn]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      [it.label, it.hint, it.group, it.keywords]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Item[]>();
    for (const it of filtered) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group)!.push(it);
    }
    return [...groups.entries()];
  }, [filtered]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[cursor];
      if (it) {
        router.push(it.href);
        setOpen(false);
      }
    }
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/30 px-4 pt-[10vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-surface-raised shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3.5">
          <Search size={18} className="shrink-0 text-ink-tertiary" strokeWidth={2} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search organizations, assets, content packs…"
            className="flex-1 bg-transparent text-base text-ink-primary placeholder-ink-tertiary focus:outline-none"
          />
          <kbd className="hidden rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs text-ink-tertiary md:inline-block">
            ESC
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-ink-tertiary">
              No results for “{query}”.
            </p>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group} className="mb-1">
                <p className="px-4 pb-1 pt-3 text-caption">{group}</p>
                {list.map((it) => {
                  const globalIndex = filtered.indexOf(it);
                  const active = globalIndex === cursor;
                  const Icon = it.icon;
                  return (
                    <Link
                      key={it.id}
                      href={it.href}
                      onClick={() => setOpen(false)}
                      onMouseEnter={() => setCursor(globalIndex)}
                      className={`flex items-center gap-3 px-4 py-2 text-sm transition ${
                        active ? 'bg-brand-soft text-brand-strong' : 'text-ink-primary hover:bg-surface-elevated'
                      }`}
                    >
                      <Icon
                        size={16}
                        strokeWidth={1.75}
                        className={active ? 'text-brand-strong' : 'text-ink-tertiary'}
                      />
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.hint && (
                        <span className="truncate text-xs text-ink-tertiary">{it.hint}</span>
                      )}
                      {active && (
                        <CornerDownLeft size={12} strokeWidth={2} className="text-brand-strong" />
                      )}
                    </Link>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line-subtle bg-surface-inset px-4 py-2 text-xs text-ink-tertiary">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-surface-raised px-1 font-mono">↑↓</kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-surface-raised px-1 font-mono">↵</kbd> open
            </span>
          </div>
          <span>
            <kbd className="rounded bg-surface-raised px-1 font-mono">⌘K</kbd> to toggle
          </span>
        </div>
      </div>
    </div>
  );
}
