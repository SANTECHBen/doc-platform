'use client';

// Hands the layout-fetched OrganizationSummary down to nested client
// components without forcing each page to re-fetch it. Read with
// useOrgWorkspace() inside a server-rendered client tree under
// /orgs/[id]/...
//
// Pages that need fresher data still fetch via the client API (e.g.
// after a mutation) — this context is just the cheap bootstrap value
// established by the layout's already-paid-for /summary call.

import { createContext, useContext, type ReactNode } from 'react';
import type { OrganizationSummary } from '@/lib/api';

interface OrgWorkspaceValue {
  summary: OrganizationSummary;
  org: OrganizationSummary['organization'];
}

const OrgWorkspaceContext = createContext<OrgWorkspaceValue | null>(null);

export function OrgWorkspaceContextProvider({
  summary,
  children,
}: {
  summary: OrganizationSummary;
  children: ReactNode;
}) {
  return (
    <OrgWorkspaceContext.Provider
      value={{ summary, org: summary.organization }}
    >
      {children}
    </OrgWorkspaceContext.Provider>
  );
}

export function useOrgWorkspace(): OrgWorkspaceValue {
  const ctx = useContext(OrgWorkspaceContext);
  if (!ctx) {
    throw new Error(
      'useOrgWorkspace must be called inside an /orgs/[id]/* route',
    );
  }
  return ctx;
}
