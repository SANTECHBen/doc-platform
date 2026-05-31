'use client';

import { Command, Globe2, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useOrgWorkspaceOptional } from '@/lib/org-workspace-context';

export function TopBar({ children }: { children?: React.ReactNode }) {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
  }, []);

  function triggerPalette() {
    const isMacRuntime = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    const ev = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: isMacRuntime,
      ctrlKey: !isMacRuntime,
      bubbles: true,
    });
    window.dispatchEvent(ev);
  }

  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-3 border-b border-line px-6 py-3.5 backdrop-blur-md lg:px-10"
      style={{ background: 'rgb(var(--surface-base) / 0.85)' }}
    >
      <div className="flex min-h-[32px] min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        <ScopeChip />
      </div>
      <button onClick={triggerPalette} className="quickfind-btn">
        <Search size={14} strokeWidth={2} />
        <span className="hidden md:inline">Quick find</span>
        <span className="kbd-row">
          <span className="kbd">
            {isMac ? <Command size={10} strokeWidth={2.5} /> : 'Ctrl'}
          </span>
          <span className="kbd">K</span>
        </span>
      </button>
      <style jsx>{`
        .quickfind-btn {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 0 10px 0 12px;
          height: 32px;
          background: rgb(var(--surface-raised));
          border: 1px solid rgb(var(--line));
          border-radius: 4px;
          color: rgb(var(--ink-tertiary));
          font-family: inherit;
          font-size: 12.5px;
          cursor: pointer;
          transition: all 140ms ease;
          flex-shrink: 0;
        }
        .quickfind-btn:hover {
          border-color: rgb(var(--line-strong));
          color: rgb(var(--ink-secondary));
        }
        .kbd-row {
          display: inline-flex;
          gap: 2px;
          align-items: center;
        }
      `}</style>
    </header>
  );
}

// Scope chip — tells the admin at a glance whether they're looking at a
// cross-organization rollup (global routes like /work-orders, /users) or
// at one organization's workspace (/orgs/[id]/...). The audit found that
// the two surfaces look identical with only the breadcrumb depth as a
// signal; on a busy screen the breadcrumb's leading items get glossed
// over. A persistent right-aligned pill in the TopBar fixes that.
//
// Org-scoped routes: org name in a brand-tinted pill, links back to the
// org's overview page so the chip doubles as a wayfinding shortcut.
// Global routes: neutral "All organizations" pill with a globe glyph,
// non-interactive — it's a label, not an affordance.
function ScopeChip() {
  const workspace = useOrgWorkspaceOptional();
  if (workspace) {
    return (
      <Link
        href={`/orgs/${workspace.org.id}`}
        className="scope-chip scope-chip-org"
        aria-label={`Workspace: ${workspace.org.name} (open overview)`}
        title={`${workspace.org.name} — open overview`}
      >
        <span className="scope-chip-dot" aria-hidden />
        <span className="scope-chip-label">{workspace.org.name}</span>
        <style jsx>{`
          .scope-chip {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 24px;
            max-width: 220px;
            padding: 0 10px;
            border-radius: 4px;
            font-family: var(--font-mono);
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            border: 1px solid;
            flex-shrink: 0;
            transition: background 140ms ease, border-color 140ms ease,
              color 140ms ease;
          }
          .scope-chip-org {
            background: rgba(var(--brand-soft-v), var(--brand-soft-a));
            color: rgb(var(--ink-brand));
            border-color: rgb(var(--brand) / 0.35);
          }
          .scope-chip-org:hover {
            background: rgba(var(--brand-soft-v), 0.16);
            border-color: rgb(var(--brand) / 0.55);
          }
          .scope-chip-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: rgb(var(--brand));
            flex-shrink: 0;
            box-shadow: 0 0 6px rgb(var(--brand) / 0.45);
          }
          .scope-chip-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
          }
        `}</style>
      </Link>
    );
  }
  return (
    <span className="scope-chip scope-chip-global" aria-label="Scope: all organizations">
      <Globe2 size={11} strokeWidth={2.25} aria-hidden />
      <span className="scope-chip-label">All organizations</span>
      <style jsx>{`
        .scope-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 24px;
          padding: 0 10px;
          border-radius: 4px;
          font-family: var(--font-mono);
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          border: 1px solid rgb(var(--line));
          background: rgb(var(--surface-raised));
          color: rgb(var(--ink-secondary));
          flex-shrink: 0;
        }
        .scope-chip-label {
          white-space: nowrap;
        }
      `}</style>
    </span>
  );
}
