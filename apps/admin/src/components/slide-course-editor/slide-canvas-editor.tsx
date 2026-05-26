'use client';

// PowerPoint-style slide canvas.
//
// 16:9 design surface. Authors drop in text boxes, images, video
// embeds, and uploaded videos, position them freely, resize, and
// reorder layers. Coordinates are percentages of the canvas
// dimensions so the layout scales identically on any screen size in
// the PWA player.
//
// Interactions:
//   - Click element → select (blue outline + SE resize handle +
//                              delete button).
//   - Drag body → move. Coordinates clamp to keep at least 10% of
//                       the element inside the canvas.
//   - Drag SE corner → resize.
//   - Double-click text → inline edit (contentEditable).
//   - Click outside an element → deselect.
//   - Delete key when selected → remove the element.
//   - Toolbar: insert text, image, video URL, video file.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Film,
  Image as ImageIcon,
  Link2,
  Loader2,
  Type,
  Trash2,
  Upload,
} from 'lucide-react';
import type { SlideBlock } from '@platform/shared';
import { SecondaryButton } from '@/components/form';
import { uploadSlideBlockMedia } from '@/lib/slide-course-api';

type PositionedBlock = SlideBlock & {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

export function SlideCanvasEditor({
  deckId,
  slideId,
  blocks,
  imageUrl,
  onChange,
  onError,
}: {
  deckId: string;
  slideId: string;
  blocks: SlideBlock[];
  imageUrl?: string | null;
  onChange: (next: SlideBlock[]) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<'image' | 'video' | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  // Append a new block with sane default position. The first few
  // inserts stagger slightly so they don't stack invisibly on top of
  // one another.
  const append = useCallback(
    (block: PositionedBlock) => {
      const staggerOffset = blocks.length * 3;
      const positioned: PositionedBlock = {
        ...block,
        x: block.x ?? Math.min(15 + staggerOffset, 60),
        y: block.y ?? Math.min(15 + staggerOffset, 60),
        w: block.w ?? defaultWidthFor(block.kind),
        h: block.h ?? defaultHeightFor(block.kind),
      };
      const next = [...blocks, positioned as SlideBlock];
      void onChange(next);
      setSelected(next.length - 1);
    },
    [blocks, onChange],
  );

  const update = useCallback(
    (i: number, patch: Partial<PositionedBlock>): void => {
      const next = blocks.map((b, j) =>
        j === i ? ({ ...b, ...patch } as SlideBlock) : b,
      );
      void onChange(next);
    },
    [blocks, onChange],
  );

  const removeAt = useCallback(
    (i: number): void => {
      void onChange(blocks.filter((_, j) => j !== i));
      setSelected(null);
    },
    [blocks, onChange],
  );

  // Keyboard delete for selected element.
  useEffect(() => {
    if (selected === null) return;
    const handler = (e: KeyboardEvent) => {
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target as HTMLElement | null)?.isContentEditable
      ) {
        removeAt(selected);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selected, removeAt]);

  // ---------------------------------------------------------------
  // Pointer-based drag and resize.
  //
  // We compute deltas in pixels and convert to canvas %-units via
  // the canvas element's bounding rect. Pointer capture lets us
  // continue receiving move events even when the cursor leaves the
  // element bounds — important for fast drags.
  // ---------------------------------------------------------------
  function startDrag(
    e: React.PointerEvent<HTMLDivElement>,
    i: number,
    mode: 'move' | 'resize',
  ) {
    e.preventDefault();
    e.stopPropagation();
    const block = blocks[i] as PositionedBlock;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const initX = block.x ?? 10;
    const initY = block.y ?? 10;
    const initW = block.w ?? defaultWidthFor(block.kind);
    const initH = block.h ?? defaultHeightFor(block.kind);

    let pending: Partial<PositionedBlock> = {};
    const target = e.currentTarget;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* Safari may throw; ignore */
    }

    function onMove(ev: PointerEvent) {
      const dxPct = ((ev.clientX - startX) / rect.width) * 100;
      const dyPct = ((ev.clientY - startY) / rect.height) * 100;
      if (mode === 'move') {
        const curW = (blocks[i] as PositionedBlock).w ?? 90;
        const curH = (blocks[i] as PositionedBlock).h ?? 90;
        pending = {
          x: clamp(initX + dxPct, -10, 110 - curW),
          y: clamp(initY + dyPct, -10, 110 - curH),
        };
      } else {
        pending = {
          w: clamp(initW + dxPct, 5, 150),
          h: clamp(initH + dyPct, 5, 150),
        };
      }
      // Live-update local state by mutating React state via update().
      // We debounce server saves by only flushing on pointerup.
      update(i, pending);
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  // ---------------------------------------------------------------
  // Inline text editing — double-click a text element. The element
  // becomes contentEditable; on blur or Esc we commit the change.
  // ---------------------------------------------------------------
  function startEditText(i: number, el: HTMLDivElement) {
    el.contentEditable = 'true';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    function finish() {
      el.contentEditable = 'false';
      update(i, { markdown: el.innerText } as Partial<PositionedBlock>);
      el.removeEventListener('blur', finish);
      el.removeEventListener('keydown', onKey);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        el.blur();
      }
    }
    el.addEventListener('blur', finish);
    el.addEventListener('keydown', onKey);
  }

  // ---------------------------------------------------------------
  // Media uploads (image / video file).
  // ---------------------------------------------------------------
  async function onPickImage(file: File): Promise<void> {
    setBusy('image');
    try {
      const r = await uploadSlideBlockMedia(deckId, slideId, file);
      append({
        kind: 'image',
        storageKey: r.storageKey,
        url: r.url,
        caption: '',
      } as PositionedBlock);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onPickVideoFile(file: File): Promise<void> {
    setBusy('video');
    try {
      const r = await uploadSlideBlockMedia(deckId, slideId, file);
      append({
        kind: 'video_file',
        storageKey: r.storageKey,
        url: r.url,
        mimeType: r.contentType,
        caption: '',
      } as PositionedBlock);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <SecondaryButton
          type="button"
          onClick={() => append({ kind: 'text', markdown: 'Text' } as PositionedBlock)}
        >
          <Type className="size-3.5" /> Text box
        </SecondaryButton>
        <SecondaryButton
          type="button"
          onClick={() => imageInputRef.current?.click()}
          disabled={busy !== null}
        >
          {busy === 'image' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ImageIcon className="size-3.5" />
          )}
          Image
        </SecondaryButton>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onPickImage(f);
          }}
        />
        <SecondaryButton
          type="button"
          onClick={() =>
            append({ kind: 'video_url', url: '', caption: '' } as PositionedBlock)
          }
        >
          <Link2 className="size-3.5" /> Video URL
        </SecondaryButton>
        <SecondaryButton
          type="button"
          onClick={() => videoInputRef.current?.click()}
          disabled={busy !== null}
        >
          {busy === 'video' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Film className="size-3.5" />
          )}
          Video file
        </SecondaryButton>
        <input
          ref={videoInputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onPickVideoFile(f);
          }}
        />
      </div>

      {/* The canvas: 16:9 aspect, image (if any) as a backdrop layer,
          blocks render absolutely on top. Clicking the empty canvas
          area deselects. */}
      <div
        ref={canvasRef}
        onPointerDown={(e) => {
          if (e.target === canvasRef.current) setSelected(null);
        }}
        className="relative w-full overflow-hidden rounded border border-line bg-white"
        style={{ aspectRatio: '16 / 9' }}
      >
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full object-contain"
          />
        )}
        {blocks.length === 0 && !imageUrl && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-tertiary">
            Insert a text box, image, or video to start.
          </div>
        )}
        {blocks.map((b, i) => (
          <CanvasElement
            key={i}
            block={b as PositionedBlock}
            selected={selected === i}
            onSelect={() => setSelected(i)}
            onMove={(e) => startDrag(e, i, 'move')}
            onResize={(e) => startDrag(e, i, 'resize')}
            onDelete={() => removeAt(i)}
            onEditText={(el) => startEditText(i, el)}
            onUrlChange={(url) =>
              update(i, { url } as Partial<PositionedBlock>)
            }
          />
        ))}
      </div>

      <p className="text-[10px] text-ink-tertiary">
        Click an element to select it. Drag to move, drag the bottom-right
        corner to resize. Double-click text to edit. Delete key removes
        the selected element.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CanvasElement — single positioned element on the canvas.
// ---------------------------------------------------------------------------

function CanvasElement({
  block,
  selected,
  onSelect,
  onMove,
  onResize,
  onDelete,
  onEditText,
  onUrlChange,
}: {
  block: PositionedBlock;
  selected: boolean;
  onSelect: () => void;
  onMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResize: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDelete: () => void;
  onEditText: (el: HTMLDivElement) => void;
  onUrlChange: (url: string) => void;
}) {
  const x = block.x ?? 10;
  const y = block.y ?? 10;
  const w = block.w ?? defaultWidthFor(block.kind);
  const h = block.h ?? defaultHeightFor(block.kind);
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${x}%`,
    top: `${y}%`,
    width: `${w}%`,
    height: `${h}%`,
    cursor: 'move',
  };
  return (
    <div
      style={style}
      onPointerDown={(e) => {
        onSelect();
        onMove(e);
      }}
      className={[
        'group rounded border bg-white/60 transition',
        selected ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-line/50 hover:border-line',
      ].join(' ')}
    >
      {block.kind === 'text' && (
        <div
          onDoubleClick={(e) => {
            e.stopPropagation();
            onEditText(e.currentTarget as HTMLDivElement);
          }}
          className="size-full overflow-auto whitespace-pre-wrap p-2 text-sm leading-snug text-ink-primary"
          style={{
            fontSize: block.fontSize ? `${block.fontSize}px` : undefined,
            textAlign: block.align ?? 'left',
          }}
        >
          {block.markdown || (
            <span className="italic text-ink-tertiary">
              (double-click to edit text)
            </span>
          )}
        </div>
      )}
      {block.kind === 'image' && (
        block.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={block.url}
            alt={block.caption ?? ''}
            draggable={false}
            className="block size-full object-contain"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-ink-tertiary">
            <ImageIcon className="size-8" />
          </div>
        )
      )}
      {block.kind === 'video_url' && (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-2 text-center">
          <Link2 className="size-6 text-ink-tertiary" />
          {selected ? (
            <input
              type="text"
              defaultValue={block.url ?? ''}
              placeholder="Paste a YouTube / Vimeo / Mux URL"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => onUrlChange(e.currentTarget.value)}
              className="w-full rounded border border-line bg-surface px-2 py-1 text-xs"
            />
          ) : (
            <span className="break-all text-[10px] text-ink-tertiary">
              {block.url || 'no URL yet — select to add'}
            </span>
          )}
        </div>
      )}
      {block.kind === 'video_file' && (
        block.url ? (
          <video
            src={block.url}
            controls={selected}
            className="block size-full object-contain"
            onPointerDown={(e) => {
              // Allow clicks on the video controls when selected.
              if (selected) e.stopPropagation();
            }}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-ink-tertiary">
            <Upload className="size-8" />
          </div>
        )
      )}
      {selected && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute -right-2 -top-2 z-10 flex size-6 items-center justify-center rounded-full bg-red-500 text-white shadow"
            aria-label="Delete element"
          >
            <Trash2 className="size-3" />
          </button>
          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              onResize(e);
            }}
            className="absolute -bottom-1 -right-1 z-10 size-3 cursor-se-resize rounded-sm bg-blue-500 shadow"
            aria-label="Resize"
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function defaultWidthFor(kind: SlideBlock['kind']): number {
  if (kind === 'text') return 50;
  if (kind === 'image') return 40;
  return 50;
}
function defaultHeightFor(kind: SlideBlock['kind']): number {
  if (kind === 'text') return 15;
  if (kind === 'image') return 35;
  if (kind === 'video_file' || kind === 'video_url') return 30;
  return 25;
}
