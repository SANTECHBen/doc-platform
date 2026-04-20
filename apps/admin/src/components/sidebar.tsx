'use client';

import {
  AlertTriangle,
  Boxes,
  Building2,
  FileStack,
  GraduationCap,
  LayoutDashboard,
  QrCode,
  ScrollText,
  Wrench,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { ThemeToggle } from './theme-toggle';

interface Nav {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: RegExp;
}

const NAV: Nav[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, match: /^\/$/ },
  { href: '/tenants', label: 'Organizations', icon: Building2, match: /^\/tenants/ },
  { href: '/asset-models', label: 'Asset models', icon: Boxes, match: /^\/asset-models/ },
  { href: '/content-packs', label: 'Content packs', icon: FileStack, match: /^\/content-packs/ },
  { href: '/training', label: 'Training', icon: GraduationCap, match: /^\/training/ },
  { href: '/parts', label: 'Parts', icon: Wrench, match: /^\/parts/ },
  { href: '/work-orders', label: 'Work orders', icon: AlertTriangle, match: /^\/work-orders/ },
  { href: '/qr-codes', label: 'QR codes', icon: QrCode, match: /^\/qr-codes/ },
  { href: '/users', label: 'Users', icon: Users, match: /^\/users/ },
  { href: '/audit', label: 'Audit log', icon: ScrollText, match: /^\/audit/ },
];

export function Sidebar({ userMenu }: { userMenu?: ReactNode }) {
  const pathname = usePathname();
  return (
    <aside
      className="sticky top-0 flex h-screen w-60 shrink-0 flex-col"
      style={{
        background: 'rgb(var(--surface-sidebar))',
        color: 'rgba(255,255,255,0.85)',
        borderRight: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <header
        className="flex items-center gap-3 px-5 py-5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="brand-mark-square">EH</div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold" style={{ color: '#fff' }}>
            Equipment Hub
          </span>
          <span
            className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em]"
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            Admin · v0.0
          </span>
        </div>
      </header>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {NAV.map((n) => {
            const active = n.match ? n.match.test(pathname ?? '/') : pathname === n.href;
            const Icon = n.icon;
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className="group relative flex items-center gap-2.5 rounded px-3 py-2 text-sm font-medium transition"
                  style={{
                    background: active ? 'rgb(var(--brand) / 0.18)' : 'transparent',
                    color: active ? '#fff' : 'rgba(255,255,255,0.65)',
                  }}
                >
                  {active && (
                    <span
                      className="absolute left-[-8px] top-2 bottom-2 w-[3px] rounded-r"
                      aria-hidden
                      style={{
                        background: 'rgb(var(--brand))',
                        boxShadow: '0 0 10px rgb(var(--brand) / 0.4)',
                      }}
                    />
                  )}
                  <Icon
                    size={16}
                    strokeWidth={active ? 2 : 1.75}
                    style={{
                      color: active ? 'rgb(var(--brand))' : 'rgba(255,255,255,0.6)',
                    }}
                  />
                  <span>{n.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <footer
        className="flex flex-col gap-2 px-5 py-3.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        {userMenu}
        <div className="flex items-center justify-between">
          <span
            className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em]"
            style={{ color: 'rgba(255,255,255,0.4)' }}
          >
            v0.0 · dev
          </span>
          <ThemeToggle />
        </div>
      </footer>
    </aside>
  );
}
