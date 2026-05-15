'use client';

import { use } from 'react';
import LegacyQrTemplateDetail from '@/app/qr-codes/templates/[id]/page';

export default function OrgQrTemplateDetail({
  params,
}: {
  params: Promise<{ id: string; templateId: string }>;
}) {
  const p = use(params);
  const remapped = Promise.resolve({ id: p.templateId });
  return <LegacyQrTemplateDetail params={remapped} />;
}
