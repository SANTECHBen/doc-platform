'use client';

import { use } from 'react';
import { AuditView } from '@/app/audit/page';

export default function OrgAudit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AuditView orgId={id} />;
}
