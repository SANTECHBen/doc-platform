'use client';

import { use, useMemo } from 'react';
import LegacyTrainingDetail from '@/app/training/[id]/page';

export default function OrgTrainingDetail({
  params,
}: {
  params: Promise<{ id: string; moduleId: string }>;
}) {
  const p = use(params);
  // Stable promise reference — see comment in
  // /orgs/[id]/asset-models/[modelId]/page.tsx for the React #300
  // motivation.
  const remapped = useMemo(
    () => Promise.resolve({ id: p.moduleId }),
    [p.moduleId],
  );
  return <LegacyTrainingDetail params={remapped} />;
}
