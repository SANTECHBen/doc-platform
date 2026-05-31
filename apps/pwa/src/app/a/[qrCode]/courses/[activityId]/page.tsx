'use client';

// Slide-course player route. URL shape:
//   /a/<qr>/courses/<activityId>
//
// Scan-session-authenticated — no Microsoft sign-in required. The
// activity ID is enough to identify the deck because each slide_course
// activity references exactly one slide deck.

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { SlideCoursePlayer } from '@/components/slide-course-player/player';

export default function SlideCourseRoute({
  params,
}: {
  params: Promise<{ qrCode: string; activityId: string }>;
}) {
  const { qrCode, activityId } = use(params);
  const router = useRouter();

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl px-3 pt-3 focus:outline-none">
      <SlideCoursePlayer
        activityId={activityId}
        onExit={() => router.push(`/a/${encodeURIComponent(qrCode)}?tab=training`)}
      />
    </main>
  );
}
