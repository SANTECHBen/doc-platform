'use client';

import { use } from 'react';
import { AuditView } from '@/components/audit-view';

export default function OrgAudit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AuditView orgId={id} />;
}
