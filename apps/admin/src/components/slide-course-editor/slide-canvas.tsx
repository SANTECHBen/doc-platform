'use client';

// SlideCanvas — center pane that renders the currently-selected slide
// image at native aspect ratio, with interaction badges overlaid as
// numbered pins. Pins are visual indicators only here — editing happens
// in the right settings panel. We could let users click the pin to jump
// into edit mode later; for v1 the rail-→-canvas-→-settings flow is
// straightforward enough.

import { Image as ImageIcon, RefreshCcw, Trash2 } from 'lucide-react';
import { GhostButton, SecondaryButton } from '@/components/form';
import type { SlideDto } from '@/lib/slide-course-api';

export function SlideCanvas({
  slide,
  onReplaceImage,
  onDeleteSlide,
}: {
  slide: SlideDto | null;
  onReplaceImage?: (file: File) => Promise<void>;
  onDeleteSlide?: () => Promise<void> | void;
}) {
  if (!slide) {
    return (
      <section className="flex min-h-[400px] items-center justify-center rounded border border-dashed border-line text-sm text-ink-tertiary">
        Select a slide to view it.
      </section>
    );
  }
  const replaceInputId = `replace-image-${slide.id}`;
  return (
    <section className="flex flex-col gap-3 rounded border border-line bg-surface-raised p-4">
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">
          Slide {slide.slideIndex + 1}
          {slide.title?.trim() ? <span className="text-ink-tertiary"> · {slide.title}</span> : ''}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-tertiary">
            {slide.imageWidth ?? '?'}×{slide.imageHeight ?? '?'} px
          </span>
          {onReplaceImage && (
            <>
              <SecondaryButton
                type="button"
                onClick={() =>
                  (document.getElementById(replaceInputId) as HTMLInputElement)?.click()
                }
              >
                <RefreshCcw className="size-3.5" /> Replace image
              </SecondaryButton>
              <input
                id={replaceInputId}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onReplaceImage(f);
                }}
              />
            </>
          )}
          {onDeleteSlide && (
            <GhostButton type="button" onClick={() => void onDeleteSlide()}>
              <Trash2 className="size-3.5" /> Delete
            </GhostButton>
          )}
        </div>
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
