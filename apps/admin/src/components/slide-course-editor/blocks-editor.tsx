'use client';

// Content-blocks editor for blank slides.
//
// Authors compose a slide from an ordered list of blocks: rich text,
// image (uploaded), video URL (YouTube/Vimeo/Mux/etc.), or video file
// (uploaded). The component is fully controlled — parent passes the
// current blocks array and a setter; this never mutates state in place.

import { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import type { SlideBlock } from '@platform/shared';
import {
  Field,
  GhostButton,
  SecondaryButton,
  TextInput,
  Textarea,
} from '@/components/form';
import { uploadSlideBlockMedia } from '@/lib/slide-course-api';

export function BlocksEditor({
  deckId,
  slideId,
  blocks,
  onChange,
  onError,
}: {
  deckId: string;
  slideId: string;
  blocks: SlideBlock[];
  onChange: (next: SlideBlock[]) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<'image' | 'video' | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);

  function update(i: number, patch: Partial<SlideBlock>): void {
    const next = blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as SlideBlock) : b));
    void onChange(next);
  }
  function removeAt(i: number): void {
    void onChange(blocks.filter((_, j) => j !== i));
  }
  function moveBy(i: number, delta: number): void {
    const j = i + delta;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void onChange(next);
  }
  function append(block: SlideBlock): void {
    void onChange([...blocks, block]);
  }

  async function onPickImage(file: File): Promise<void> {
    setBusy('image');
    try {
      const r = await uploadSlideBlockMedia(deckId, slideId, file);
      append({
        kind: 'image',
        storageKey: r.storageKey,
        url: r.url,
        caption: '',
      });
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
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {blocks.length === 0 && (
        <p className="rounded border border-dashed border-line bg-surface p-3 text-xs text-ink-tertiary">
          No content blocks yet. Add a text, image, or video block below.
        </p>
      )}

      {blocks.map((block, i) => (
        <div
          key={i}
          className="space-y-2 rounded border border-line bg-surface p-2"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium text-on-accent">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                {labelFor(block.kind)}
              </p>
            </div>
            <div className="flex gap-1">
              <GhostButton
                type="button"
                onClick={() => moveBy(i, -1)}
                disabled={i === 0}
                aria-label="Move up"
              >
                <ChevronUp className="size-3.5" />
              </GhostButton>
              <GhostButton
                type="button"
                onClick={() => moveBy(i, 1)}
                disabled={i === blocks.length - 1}
                aria-label="Move down"
              >
                <ChevronDown className="size-3.5" />
              </GhostButton>
              <GhostButton
                type="button"
                onClick={() => removeAt(i)}
                aria-label="Delete"
              >
                <Trash2 className="size-3.5" />
              </GhostButton>
            </div>
          </div>
          {block.kind === 'text' && (
            <Textarea
              value={block.markdown}
              onChange={(e) => update(i, { markdown: e.target.value })}
              rows={4}
              placeholder="Write text… markdown is supported (headings, lists, links, **bold**, *italic*)."
              maxLength={16000}
            />
          )}
          {block.kind === 'image' && (
            <div className="space-y-2">
              {block.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={block.url}
                  alt={block.caption ?? ''}
                  className="max-h-48 w-auto rounded border border-line"
                />
              )}
              <Field label="Caption (optional)">
                <TextInput
                  value={block.caption ?? ''}
                  onChange={(e) => update(i, { caption: e.target.value })}
                  maxLength={500}
                />
              </Field>
            </div>
          )}
          {block.kind === 'video_url' && (
            <div className="space-y-2">
              <Field
                label="Video URL"
                hint="YouTube, Vimeo, Mux, or any embeddable URL. The player renders it in an iframe."
              >
                <TextInput
                  value={block.url}
                  onChange={(e) => update(i, { url: e.target.value })}
                  placeholder="https://www.youtube.com/watch?v=…"
                />
              </Field>
              <Field label="Caption (optional)">
                <TextInput
                  value={block.caption ?? ''}
                  onChange={(e) => update(i, { caption: e.target.value })}
                  maxLength={500}
                />
              </Field>
            </div>
          )}
          {block.kind === 'video_file' && (
            <div className="space-y-2">
              {block.url && (
                <video
                  src={block.url}
                  controls
                  className="max-h-48 w-auto rounded border border-line"
                />
              )}
              <Field label="Caption (optional)">
                <TextInput
                  value={block.caption ?? ''}
                  onChange={(e) => update(i, { caption: e.target.value })}
                  maxLength={500}
                />
              </Field>
            </div>
          )}
        </div>
      ))}

      <div className="flex flex-wrap gap-2 pt-1">
        <SecondaryButton
          type="button"
          onClick={() => append({ kind: 'text', markdown: '' })}
        >
          <FileText className="size-3.5" /> Text
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
            append({ kind: 'video_url', url: '', caption: '' })
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
      <p className="text-[10px] text-ink-tertiary">
        <Plus className="inline size-3" /> appends a new block. Use the arrows
        on each card to reorder.
      </p>
    </div>
  );
}

function labelFor(kind: SlideBlock['kind']): string {
  if (kind === 'text') return 'Text';
  if (kind === 'image') return 'Image';
  if (kind === 'video_url') return 'Video — link';
  return 'Video — file';
}
