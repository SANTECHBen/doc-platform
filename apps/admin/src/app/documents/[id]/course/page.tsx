'use client';

// Slide course editor — opened from the document detail page when the
// uploaded PPTX has a slide_decks row. The page itself is thin; the heavy
// editor lives in components/slide-course-editor.

import { use } from 'react';
import { SlideCourseEditor } from '@/components/slide-course-editor/slide-course-editor';

export default function SlideCoursePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <SlideCourseEditor documentId={id} />;
}
