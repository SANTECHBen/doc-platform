'use client';

import LegacyAgentRuns from '@/app/agent/page';

// v1: agent runs list is global. The detail page exposes target_org_id;
// adding per-org filtering to the list endpoint is a follow-up.
export default function OrgAgentRuns() {
  return <LegacyAgentRuns />;
}
