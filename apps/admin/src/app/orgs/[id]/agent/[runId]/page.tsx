'use client';

import { use } from 'react';
import LegacyAgentRunDetail from '@/app/agent/[runId]/page';

export default function OrgAgentRunDetail({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const p = use(params);
  const remapped = Promise.resolve({ runId: p.runId });
  return <LegacyAgentRunDetail params={remapped} />;
}
