// Server layout for /orgs/[id]/*. Two responsibilities:
//
//  1. Security boundary. requireOrgAccess() either returns the
//     OrganizationSummary (user has scope) or calls notFound() (user
//     doesn't, OR the org doesn't exist — we can't tell which by
//     design, to avoid id enumeration). Every page nested under here
//     is therefore guaranteed to be rendering for an authorized org.
//
//  2. Workspace chrome. Renders the org-scoped sidebar with the org
//     identity baked in (name, type, initials), so every nested page
//     sees the same "you are inside <Customer>" framing.

import { OrgSidebar } from '@/components/org-sidebar';
import { UserMenu } from '@/components/user-menu';
import { requireOrgAccess } from '@/lib/org-access';
import type { ReactNode } from 'react';
import { OrgWorkspaceContextProvider } from './workspace-context';

export default async function OrgLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: ReactNode;
}) {
  const { id } = await params;
  const { summary } = await requireOrgAccess(id);
  const org = summary.organization;

  return (
    <div className="flex min-h-screen">
      <OrgSidebar
        org={{ id: org.id, name: org.name, type: org.type }}
        userMenu={<UserMenu />}
      />
      <div className="flex min-h-screen flex-1 flex-col">
        <OrgWorkspaceContextProvider summary={summary}>
          <main className="flex-1">{children}</main>
        </OrgWorkspaceContextProvider>
      </div>
    </div>
  );
}
