'use client';

// SlideCanvas — center pane that renders the currently-selected slide
// image at native aspect ratio, with interaction badges overlaid as
// numbered pins. Pins are visual indicators only here — editing happens
// in the right settings panel. We could let users click the pin to jump
// into edit mode later; for v1 the rail-→-canvas-→-settings flow is
// straightforward enough.

import { Image as ImageIcon } from 'lucide-react';
import type { SlideDto } from '@/lib/slide-course-api';

export function SlideCanvas({ slide }: { slide: SlideDto | null }) {
  if (!slide) {
    return (
      <section className="flex min-h-[400px] items-center justify-center rounded border border-dashed border-line text-sm text-ink-tertiary">
        Select a slide to view it.
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded border border-line bg-surface-raised p-4">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          Slide {slide.slideIndex + 1}
          {slide.title?.trim() ? <span className="text-ink-tertiary"> · {slide.title}</span> : ''}
        </h3>
        <span className="text-xs text-ink-tertiary">
          {slide.imageWidth ?? '?'}×{slide.imageHeight ?? '?'} px
        </span>
      </header>
      <div className="relative w-full overflow-hidden rounded border border-line bg-surface">
        {slide.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={slide.imageUrl}
            alt={`Slide ${slide.slideIndex + 1}`}
            className="block h-auto w-full"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center text-ink-tertiary">
            <ImageIcon className="size-8" />
          </div>
        )}
        {slide.interactions.length > 0 && (
          <div className="absolute right-3 top-3 flex flex-col gap-2">
            {slide.interactions.map((it, i) => (
              <span
                key={it.id}
                title={`${it.kind} · ${it.prompt}`}
                className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-medium text-on-accent shadow"
              >
                {i + 1}
              </span>
            ))}
          </div>
        )}
      </div>
      {slide.speakerNotesMarkdown && (
        <details className="rounded border border-line bg-surface px-3 py-2 text-xs text-ink-secondary">
          <summary className="cursor-pointer text-ink-tertiary">
            Speaker notes from PowerPoint
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans">
            {slide.speakerNotesMarkdown}
          </pre>
        </details>
      )}
    </section>
  );
}
