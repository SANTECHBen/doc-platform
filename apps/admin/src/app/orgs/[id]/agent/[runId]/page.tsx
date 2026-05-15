'use client';

import { use, useMemo } from 'react';
import LegacyAgentRunDetail from '@/app/agent/[runId]/page';

export default function OrgAgentRunDetail({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const p = use(params);
  // Stable promise reference — see /orgs/[id]/asset-models/[modelId]/page.tsx
  // for the React #300 motivation.
  const remapped = useMemo(
    () => Promise.resolve({ runId: p.runId }),
    [p.runId],
  );
  return <LegacyAgentRunDetail params={remapped} />;
}
