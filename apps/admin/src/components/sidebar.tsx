'use client';

// Global admin left rail. Renders the shared <NavSidebar /> with the
// top-level (cross-organization) nav groups. Hides itself on:
//   • /orgs/[id]/* — the org workspace mounts its own OrgSidebar
//   • /procedures/[id]/edit — focus mode for the full-page editor
//
// The hide-by-returning-null pattern keeps the root layout simple: it
// always renders <Sidebar />, and the component decides whether it
// should appear based on the current pathname.

import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  Building2,
  FileStack,
  GraduationCap,
  LayoutDashboard,
  QrCode,
  ScrollText,
  Users,
  Wrench,
} from 'lucide-react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavSidebar, type NavGroup } from './nav-sidebar';

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
      { href: '/orgs', label: 'Organizations', icon: Building2, match: /^\/(orgs|tenants)/ },
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

  // Inside an org workspace, the org-scoped layout owns the sidebar via
  // <OrgSidebar>. Hide ourselves so the workspace sidebar sits at the
  // left edge with no double-rail. We exclude /orgs (exact) so the
  // organization-picker route still shows this global sidebar.
  if (pathname && /^\/orgs\/[^/]+(\/.*)?$/.test(pathname) && pathname !== '/orgs') {
    return null;
  }

  // Hide on the full-page procedure editor. That surface is focus mode
  // where every horizontal pixel helps; users navigate out via the
  // editor's own header.
  if (pathname && /^\/procedures\/[^/]+\/edit$/.test(pathname)) {
    return null;
  }

  return <NavSidebar header={<GlobalHeader />} groups={GROUPS} userMenu={userMenu} />;
}

function GlobalHeader() {
  return (
    <header className="flex items-center gap-3 px-5 py-5">
      <div className="brand-mark-square">FS</div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold" style={{ color: '#fff' }}>
          FieldSupport
        </span>
      </div>
    </header>
  );
}
