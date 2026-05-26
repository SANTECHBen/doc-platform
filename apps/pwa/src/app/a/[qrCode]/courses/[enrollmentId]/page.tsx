'use client';

// Slide-course player route. URL shape:
//   /a/<qr>/courses/<enrollmentId>?activity=<activityId>
//
// The PWA's home page is /a/[qrCode]; courses are nested under the
// asset so the back-link returns to the training tab on that asset.

import { use } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SlideCoursePlayer } from '@/components/slide-course-player/player';

export default function SlideCourseRoute({
  params,
}: {
  params: Promise<{ qrCode: string; enrollmentId: string }>;
}) {
  const { qrCode, enrollmentId } = use(params);
  const router = useRouter();
  const sp = useSearchParams();
  const activityId = sp.get('activity') ?? '';

  if (!activityId) {
    return (
      <div className="p-4 text-sm text-ink-tertiary">
        Missing <code>?activity=&lt;activityId&gt;</code> in the URL.
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-3 pt-3">
      <SlideCoursePlayer
        enrollmentId={enrollmentId}
        activityId={activityId}
        onExit={() => router.push(`/a/${encodeURIComponent(qrCode)}?tab=training`)}
      />
    </main>
  );
}
