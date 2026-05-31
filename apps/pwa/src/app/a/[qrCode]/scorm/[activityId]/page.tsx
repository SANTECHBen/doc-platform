'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { ScormPlayer } from '@/components/scorm-player/scorm-player';

export default function ScormRoute({
  params,
}: {
  params: Promise<{ qrCode: string; activityId: string }>;
}) {
  const { qrCode, activityId } = use(params);
  const router = useRouter();
  return (
    <main id="main" tabIndex={-1} className="focus:outline-none">
      <ScormPlayer
        activityId={activityId}
        onExit={() => router.push(`/a/${encodeURIComponent(qrCode)}?tab=training`)}
      />
    </main>
  );
}
