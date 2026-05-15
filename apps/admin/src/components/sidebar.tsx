'use client';

import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  Building2,
  FileStack,
  GraduationCap,
  Info,
  LayoutDashboard,
  QrCode,
  ScrollText,
  Wrench,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ThemeToggle } from './theme-toggle';

interface Nav {
  href: string;
  label: string;
  icon: LucideIcon;
  match?: RegExp;
}

interface NavGroup {
  id: string;
  label: string | null;
  info?: string;
  items: Nav[];
}

const GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: null,
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard, match: /^\/$/ },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    info: 'Start here when onboarding a new customer. Create their organization, invite the people who will use the system, and (optionally) let the AI agent ingest their existing equipment list to seed everything in bulk.',
    items: [
      { href: '/tenants', label: 'Organizations', icon: Building2, match: /^\/tenants/ },
      { href: '/users', label: 'Users', icon: Users, match: /^\/users/ },
      { href: '/agent', label: 'Onboarding agent', icon: Bot, match: /^\/agent/ },
    ],
  },
  {
    id: 'catalog',
    label: 'Catalog',
    info: 'Build the library of what the customer owns and how to maintain it. Define each piece of equipment (asset model), list its replacement parts, attach manuals and procedures (content packs), and create training courses for technicians.',
    items: [
      { href: '/asset-models', label: 'Asset models', icon: Boxes, match: /^\/asset-models/ },
      { href: '/parts', label: 'Parts', icon: Wrench, match: /^\/parts/ },
      { href: '/content-packs', label: 'Content packs', icon: FileStack, match: /^\/content-packs/ },
      { href: '/training', label: 'Training', icon: GraduationCap, match: /^\/training/ },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    info: 'Day-to-day work after setup is done. Track repair tickets (work orders) and print QR code labels that field techs scan on equipment to pull up the right manuals, parts, and procedures.',
    items: [
      { href: '/work-orders', label: 'Work orders', icon: AlertTriangle, match: /^\/work-orders/ },
      { href: '/qr-codes', label: 'QR codes', icon: QrCode, match: /^\/qr-codes/ },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    info: 'See what is happening across the platform. Analytics shows how the content is being used in the field, and the audit log records every change for compliance and troubleshooting.',
    items: [
      { href: '/analytics', label: 'Analytics', icon: Activity, match: /^\/analytics/ },
      { href: '/audit', label: 'Audit log', icon: ScrollText, match: /^\/audit/ },
    ],
  },
];

export function Sidebar({ userMenu }: { userMenu?: ReactNode }) {
  const pathname = usePathname();
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!openInfo) return;
    function onDown(e: MouseEvent) {
      if (!navRef.current?.contains(e.target as Node)) setOpenInfo(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenInfo(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openInfo]);

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

      <nav ref={navRef} className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-3">
          {GROUPS.map((group) => (
            <li key={group.id}>
              {group.label && (
                <div className="relative flex items-center justify-between px-3 pb-1 pt-1">
                  <span
                    className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: 'rgba(255,255,255,0.38)' }}
                  >
                    {group.label}
                  </span>
                  {group.info && (
                    <>
                      <button
                        type="button"
                        aria-label={`What is ${group.label}?`}
                        aria-expanded={openInfo === group.id}
                        onClick={() =>
                          setOpenInfo((v) => (v === group.id ? null : group.id))
                        }
                        className="grid h-4 w-4 place-items-center rounded-full transition"
                        style={{
                          color:
                            openInfo === group.id
                              ? 'rgb(var(--brand))'
                              : 'rgba(255,255,255,0.4)',
                          background:
                            openInfo === group.id
                              ? 'rgb(var(--brand) / 0.18)'
                              : 'transparent',
                        }}
                      >
                        <Info size={11} strokeWidth={2.25} />
                      </button>
                      {openInfo === group.id && (
                        <div
                          role="dialog"
                          aria-label={`${group.label} description`}
                          className="absolute left-full top-0 z-50 ml-2 w-64 rounded-md p-3 text-xs leading-relaxed shadow-xl"
                          style={{
                            background: '#1a1d24',
                            color: 'rgba(255,255,255,0.85)',
                            border: '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <div
                            className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
                            style={{ color: 'rgb(var(--brand))' }}
                          >
                            {group.label}
                          </div>
                          <p>{group.info}</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((n) => {
                  const active = n.match
                    ? n.match.test(pathname ?? '/')
                    : pathname === n.href;
                  const Icon = n.icon;
                  return (
                    <li key={n.href}>
                      <Link
                        href={n.href}
                        className="group relative flex items-center gap-2.5 rounded px-3 py-2 text-sm font-medium transition"
                        style={{
                          background: active
                            ? 'rgb(var(--brand) / 0.18)'
                            : 'transparent',
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
                            color: active
                              ? 'rgb(var(--brand))'
                              : 'rgba(255,255,255,0.6)',
                          }}
                        />
                        <span>{n.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
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
