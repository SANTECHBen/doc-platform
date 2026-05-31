'use client';

// NavSidebar — the shared dark-themed left rail used by both the
// top-level admin Sidebar and the per-org OrgSidebar. Same chrome on
// both: header slot (logo OR org identity) + grouped nav with info
// popovers + footer (UserMenu + ThemeToggle).
//
// Both wrappers used to copy/paste the entire group renderer, info-
// popover machinery, and footer markup. This file is the single source
// of truth; the wrappers (sidebar.tsx, org-sidebar.tsx) now only
// declare their groups + header.

import { Info, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ThemeToggle } from './theme-toggle';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Optional path matcher — defaults to exact `href` equality. Use when
   *  a nav item should stay active for child routes (e.g. `/asset-models/[id]`
   *  highlights the `/asset-models` parent). */
  match?: RegExp;
}

export interface NavGroup {
  id: string;
  /** null = ungrouped (renders without a section header — used for the
   *  Overview/Dashboard item that sits at the top of the rail). */
  label: string | null;
  /** Plain-English description for the section, surfaced via the info
   *  popover next to the group label. */
  info?: string;
  items: NavItem[];
}

export function NavSidebar({
  header,
  groups,
  userMenu,
}: {
  header: ReactNode;
  groups: NavGroup[];
  userMenu?: ReactNode;
}) {
  const pathname = usePathname();
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  // Info popover dismissal — click outside or Escape closes whichever
  // group's info card is open. Wired only while one is open so we
  // don't leak listeners on every sidebar mount.
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
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {header}
      </div>

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
        <div className="flex items-center justify-end">
          <ThemeToggle />
        </div>
      </footer>
    </aside>
  );
}
