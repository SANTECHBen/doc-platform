'use client';

// Wrapper around the legacy content pack detail editor. URL gives us
// { id: orgId, packId }; the legacy page expects { id: packId }.
import { use } from 'react';
import LegacyContentPackDetail from '@/app/content-packs/[id]/page';

export default function OrgContentPackDetail({
  params,
}: {
  params: Promise<{ id: string; packId: string }>;
}) {
  const p = use(params);
  const remapped = Promise.resolve({ id: p.packId });
  return <LegacyContentPackDetail params={remapped} />;
}
