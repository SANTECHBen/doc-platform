'use client';

import { use, useMemo } from 'react';
import LegacyQrTemplateDetail from '@/app/qr-codes/templates/[id]/page';

export default function OrgQrTemplateDetail({
  params,
}: {
  params: Promise<{ id: string; templateId: string }>;
}) {
  const p = use(params);
  // Stable promise reference — see /orgs/[id]/asset-models/[modelId]/page.tsx
  // for the React #300 motivation.
  const remapped = useMemo(
    () => Promise.resolve({ id: p.templateId }),
    [p.templateId],
  );
  return <LegacyQrTemplateDetail params={remapped} />;
}
