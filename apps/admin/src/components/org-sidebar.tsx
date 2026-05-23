'use client';

import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  Building2,
  ChevronLeft,
  Clapperboard,
  FileStack,
  GraduationCap,
  Info,
  LayoutDashboard,
  MapPin,
  Puzzle,
  QrCode,
  ScrollText,
  Settings,
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

function buildGroups(orgId: string): NavGroup[] {
  const base = `/orgs/${orgId}`;
  return [
    {
      id: 'overview',
      label: null,
      items: [
        {
          href: base,
          label: 'Overview',
          icon: LayoutDashboard,
          match: new RegExp(`^/orgs/${orgId}/?$`),
        },
      ],
    },
    {
      id: 'setup',
      label: 'Setup',
      info:
        'Where new customers get bootstrapped. Add the physical sites that will host equipment, invite the people who will use the system, and (optionally) let the AI agent ingest an existing equipment list to seed everything in bulk.',
      items: [
        {
          href: `${base}/sites`,
          label: 'Sites',
          icon: MapPin,
          match: new RegExp(`^/orgs/${orgId}/sites`),
        },
        {
          href: `${base}/users`,
          label: 'Users',
          icon: Users,
          match: new RegExp(`^/orgs/${orgId}/users`),
        },
        {
          href: `${base}/agent`,
          label: 'Onboarding agent',
          icon: Bot,
          match: new RegExp(`^/orgs/${orgId}/agent`),
        },
      ],
    },
    {
      id: 'catalog',
      label: 'Catalog',
      info:
        "Build the library of what this customer owns and how to maintain it. Define each piece of equipment (asset model), list its replacement parts, attach manuals and procedures (content packs), and create training courses for technicians.",
      items: [
        {
          href: `${base}/asset-models`,
          label: 'Asset models',
          icon: Boxes,
          match: new RegExp(`^/orgs/${orgId}/asset-models`),
        },
        {
          href: `${base}/parts`,
          label: 'Parts',
          icon: Wrench,
          match: new RegExp(`^/orgs/${orgId}/parts`),
        },
        {
          href: `${base}/content-packs`,
          label: 'Content packs',
          icon: FileStack,
          match: new RegExp(`^/orgs/${orgId}/content-packs`),
        },
        {
          href: `${base}/training`,
          label: 'Training',
          icon: GraduationCap,
          match: new RegExp(`^/orgs/${orgId}/training`),
        },
      ],
    },
    {
      id: 'authoring',
      label: 'Authoring',
      info:
        'Tools that speed up writing and maintaining procedures. Snippets are reusable step content (LOTO, safety briefings) referenced from any procedure. AI drafts ingests a video walkthrough and proposes a structured procedure for review.',
      items: [
        // Snippets and drafts are platform-wide surfaces, not per-org
        // routes — both filter by org server-side. Linking to the global
        // paths keeps a single list to manage and avoids duplicating
        // pages under /orgs/[id]/...
        {
          href: '/snippets',
          label: 'Snippets',
          icon: Puzzle,
          match: /^\/snippets/,
        },
        {
          href: '/procedure-drafts',
          label: 'AI video drafts',
          icon: Clapperboard,
          match: /^\/procedure-drafts/,
        },
      ],
    },
    {
      id: 'operations',
      label: 'Operations',
      info:
        'Day-to-day work after setup is done. Track repair tickets (work orders) and print QR code labels that field technicians scan on equipment to pull up the right manuals, parts, and procedures.',
      items: [
        {
          href: `${base}/work-orders`,
          label: 'Work orders',
          icon: AlertTriangle,
          match: new RegExp(`^/orgs/${orgId}/work-orders`),
        },
        {
          href: `${base}/qr-codes`,
          label: 'QR codes',
          icon: QrCode,
          match: new RegExp(`^/orgs/${orgId}/qr-codes`),
        },
      ],
    },
    {
      id: 'insights',
      label: 'Insights',
      info:
        'See what is happening across this customer. Analytics shows how the content is being used in the field, and the audit log records every change for compliance and troubleshooting.',
      items: [
        {
          href: `${base}/analytics`,
          label: 'Analytics',
          icon: Activity,
          match: new RegExp(`^/orgs/${orgId}/analytics`),
        },
        {
          href: `${base}/audit`,
          label: 'Audit log',
          icon: ScrollText,
          match: new RegExp(`^/orgs/${orgId}/audit`),
        },
      ],
    },
    {
      id: 'admin',
      label: 'Settings',
      info:
        'Customer-level configuration. Update branding shown on the PWA when techs scan equipment, manage privacy / scan-access policies, and edit the organization profile.',
      items: [
        {
          href: `${base}/settings`,
          label: 'Settings',
          icon: Settings,
          match: new RegExp(`^/orgs/${orgId}/settings`),
        },
      ],
    },
  ];
}

interface OrgSummaryHeader {
  id: string;
  name: string;
  type: 'oem' | 'dealer' | 'integrator' | 'end_customer';
}

export function OrgSidebar({
  org,
  userMenu,
}: {
  org: OrgSummaryHeader;
  userMenu?: ReactNode;
}) {
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

  const groups = buildGroups(org.id);
  const typeLabel = formatType(org.type);

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
        className="flex flex-col gap-2.5 px-4 pb-3 pt-4"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <Link
          href="/orgs"
          className="inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] transition"
          style={{ color: 'rgba(255,255,255,0.5)' }}
        >
          <ChevronLeft size={11} strokeWidth={2.25} />
          <span>All organizations</span>
        </Link>
        <Link
          href={`/orgs/${org.id}`}
          className="flex items-start gap-2.5 rounded px-1 py-0.5"
        >
          <div
            className="grid h-8 w-8 shrink-0 place-items-center rounded font-mono text-xs font-bold"
            style={{
              background: 'rgb(var(--brand) / 0.18)',
              color: 'rgb(var(--brand))',
            }}
            aria-hidden
          >
            {initials(org.name)}
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span
              className="truncate text-sm font-semibold"
              style={{ color: '#fff' }}
              title={org.name}
            >
              {org.name}
            </span>
            <span
              className="font-mono text-[10px] font-medium uppercase tracking-[0.08em]"
              style={{ color: 'rgba(255,255,255,0.45)' }}
            >
              {typeLabel}
            </span>
          </div>
        </Link>
      </header>

      <nav ref={navRef} className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
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

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '·';
}

function formatType(type: OrgSummaryHeader['type']): string {
  switch (type) {
    case 'oem':
      return 'OEM';
    case 'dealer':
      return 'Dealer';
    case 'integrator':
      return 'Integrator';
    case 'end_customer':
      return 'End customer';
  }
}
