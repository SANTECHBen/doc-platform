'use client';

// SlideRail — vertical, scrollable list of slide thumbnails on the left
// of the editor. Selecting a slide drives what the center canvas and
// right settings panel render. Reorder uses HTML5 drag-and-drop —
// good-enough fidelity for desktop authoring, zero added dependencies.
//
// State invariants:
//   - The parent component is the source of truth for ordering. We
//     compute new orderingHints based on the visual position the user
//     dropped onto and bubble up via onReorder.
//   - Drag highlights show drop-target indicator above the hovered
//     slide row so the placement is unambiguous.

import { useState } from 'react';
import { GripVertical } from 'lucide-react';
import type { SlideDto } from '@/lib/slide-course-api';

interface SlideRailProps {
  slides: SlideDto[];
  selectedSlideId: string | null;
  onSelect: (slideId: string) => void;
  onReorder: (orderings: { slideId: string; orderingHint: number }[]) => void;
}

export function SlideRail(props: SlideRailProps) {
  const { slides, selectedSlideId, onSelect, onReorder } = props;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  function onDrop(targetIndex: number) {
    if (!draggingId) return;
    const fromIndex = slides.findIndex((s) => s.id === draggingId);
    if (fromIndex < 0 || fromIndex === targetIndex) {
      setDraggingId(null);
      setHoverIndex(null);
      return;
    }
    const reordered = [...slides];
    const [moved] = reordered.splice(fromIndex, 1);
    // When dragging downward, splice(target, 0) lands before the target;
    // adjust so dropping AFTER target lands after.
    const insertAt = targetIndex > fromIndex ? targetIndex : targetIndex;
    reordered.splice(insertAt, 0, moved!);
    // Re-stamp orderingHint as 0..N-1. Server will accept these directly.
    const orderings = reordered.map((s, i) => ({ slideId: s.id, orderingHint: i }));
    onReorder(orderings);
    setDraggingId(null);
    setHoverIndex(null);
  }

  return (
    <aside className="flex max-h-[calc(100vh-12rem)] flex-col rounded border border-line bg-surface-raised">
      <div className="border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        Slides ({slides.length})
      </div>
      <ol className="flex-1 overflow-y-auto py-1">
        {slides.map((slide, i) => {
          const isSelected = slide.id === selectedSlideId;
          const isDragging = draggingId === slide.id;
          const showDropAbove = hoverIndex === i && draggingId !== slide.id;
          return (
            <li
              key={slide.id}
              draggable
              onDragStart={(e) => {
                setDraggingId(slide.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setHoverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setHoverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(i);
              }}
              className={[
                'relative mx-2 my-0.5 rounded transition',
                showDropAbove ? 'before:absolute before:-top-0.5 before:left-0 before:right-0 before:h-0.5 before:bg-accent' : '',
                isDragging ? 'opacity-50' : '',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => onSelect(slide.id)}
                className={[
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition',
                  isSelected
                    ? 'bg-accent/15 ring-1 ring-accent'
                    : 'hover:bg-surface',
                ].join(' ')}
              >
                <GripVertical className="size-3.5 shrink-0 text-ink-tertiary" />
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-ink-tertiary">
                  {i + 1}
                </span>
                <span className="relative size-12 shrink-0 overflow-hidden rounded border border-line bg-surface">
                  {slide.imageUrl && (
                    // Plain <img> rather than next/image — the source is a
                    // dynamic auth-gated /files/* URL that next/image's
                    // built-in optimizer would proxy and break authz.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={slide.imageUrl}
                      alt={`Slide ${i + 1}`}
                      className="size-full object-cover"
                    />
                  )}
                  {slide.interactions.length > 0 && (
                    <span className="absolute right-0 top-0 rounded-bl bg-accent px-1 text-[10px] font-medium leading-4 text-on-accent">
                      {slide.interactions.length}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {slide.title?.trim() || `Slide ${i + 1}`}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
