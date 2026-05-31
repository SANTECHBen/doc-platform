'use client';

// Hands the layout-fetched OrganizationSummary down to nested client
// components without forcing each page to re-fetch it. Read with
// useOrgWorkspace() (asserts presence) or useOrgWorkspaceOptional()
// (returns null outside an org workspace, used by global chrome like
// the TopBar that needs to detect scope).
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

// Strict: throws if called outside an /orgs/[id]/* route.
export function useOrgWorkspace(): OrgWorkspaceValue {
  const ctx = useContext(OrgWorkspaceContext);
  if (!ctx) {
    throw new Error(
      'useOrgWorkspace must be called inside an /orgs/[id]/* route',
    );
  }
  return ctx;
}

// Optional: returns null outside an /orgs/[id]/* route. Used by global
// chrome like the TopBar's scope chip to detect whether it's rendering
// inside an org workspace.
export function useOrgWorkspaceOptional(): OrgWorkspaceValue | null {
  return useContext(OrgWorkspaceContext);
}
