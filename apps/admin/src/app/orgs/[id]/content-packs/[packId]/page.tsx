'use client';

// Wrapper around the legacy content pack detail editor. URL gives us
// { id: orgId, packId }; the legacy page expects { id: packId }.
// useMemo keeps the params promise reference stable across renders so
// the legacy `use(params)` doesn't loop on a fresh promise each tick
// (React error #300).
import { use, useMemo } from 'react';
import LegacyContentPackDetail from '@/app/content-packs/[id]/page';

export default function OrgContentPackDetail({
  params,
}: {
  params: Promise<{ id: string; packId: string }>;
}) {
  const p = use(params);
  const remapped = useMemo(
    () => Promise.resolve({ id: p.packId }),
    [p.packId],
  );
  return <LegacyContentPackDetail params={remapped} />;
}
