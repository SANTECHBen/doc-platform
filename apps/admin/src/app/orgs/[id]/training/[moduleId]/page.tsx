'use client';

import { use } from 'react';
import LegacyTrainingDetail from '@/app/training/[id]/page';

export default function OrgTrainingDetail({
  params,
}: {
  params: Promise<{ id: string; moduleId: string }>;
}) {
  const p = use(params);
  const remapped = Promise.resolve({ id: p.moduleId });
  return <LegacyTrainingDetail params={remapped} />;
}
