'use client';

// BlockListEditor — typed structured content authoring for a procedure
// step. Replaces the freeform markdown body. Authors pick a block kind
// from the slash menu; the template owns visual style at render time so
// every callout / table / list looks the same across the library.
//
// Architecture notes:
//
//   - The list is the source of truth; each block is editable in place.
//   - Add buttons live ABOVE the first block, BETWEEN blocks, and AFTER
//     the last block. All three open the same picker.
//   - Drag-to-reorder uses HTML5 native DnD (mirrors step reordering).
//   - Auto-save is the parent's responsibility — we just emit the new
//     blocks array on change. Parent debounces.
//
//   - Per-block editors are intentionally minimal. There is exactly one
//     way to express each idea — the author can't accidentally write a
//     "warning" using bold text instead of a callout, because there's no
//     inline bold to reach for.

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  GripVertical,
  Image as ImageIcon,
  Info,
  Lightbulb,
  List,
  ListOrdered,
  Loader2,
  Plus,
  ShieldAlert,
  Table as TableIcon,
  Trash2,
  Type,
  Upload,
  X,
} from 'lucide-react';
import type { StepBlock, AdminStepMedia } from '@/lib/api';

export type StepBlockKind = StepBlock['kind'];

interface Props {
  blocks: StepBlock[];
  onChange: (next: StepBlock[]) => void;
  /** Step's own media items, exposed to the photo_inline block as a
   *  picker. */
  stepMedia: AdminStepMedia[];
  /** Upload a new photo/video to the step's media[] from inside the
   *  PhotoInline block. Returns the new media item so the picker can
   *  auto-select it. */
  onUploadStepMedia?: (file: File) => Promise<AdminStepMedia>;
  /** Remove a photo from the step's media[] (used by the PhotoInline block's
   *  Replace/Remove affordances so swapping an image doesn't leave the old
   *  one behind). */
  onDeleteStepMedia?: (storageKey: string) => Promise<void>;
  /** Optional legacy bodyMarkdown — when present and blocks is empty,
   *  we offer a one-click "Import from markdown" affordance. */
  legacyBodyMarkdown?: string | null;
  onImportLegacy?: () => void;
}

// Ordering note: the first four entries become the empty-state /
// end-of-list quick-pick buttons (BLOCK_PICKER.slice(0, 4)) so the
// "+5 More" overflow only catches the less common kinds. Photo sits
// second after Paragraph because most procedure steps are
// "write a sentence, attach a photo of the thing".
const BLOCK_PICKER: Array<{
  kind: StepBlockKind;
  label: string;
  description: string;
  icon: typeof Type;
}> = [
  {
    kind: 'paragraph',
    label: 'Paragraph',
    description: 'Plain prose. Links auto-detected.',
    icon: Type,
  },
  {
    kind: 'photo_inline',
    label: 'Photo',
    description: 'Reference a photo already on this step.',
    icon: ImageIcon,
  },
  {
    kind: 'callout',
    label: 'Callout',
    description: 'Safety, warning, tip, or note — styled by template.',
    icon: AlertTriangle,
  },
  {
    kind: 'bullet_list',
    label: 'Bullet list',
    description: 'Unordered list of short items.',
    icon: List,
  },
  {
    kind: 'numbered_list',
    label: 'Numbered list',
    description: 'Ordered list of short items.',
    icon: ListOrdered,
  },
  {
    kind: 'key_value',
    label: 'Key/value table',
    description: 'Two-column reference table — torque chart, parts list.',
    icon: TableIcon,
  },
];

// Default-block constructors. Used by the picker to insert a fresh block
// at the requested position without hand-building empty fields each time.
function makeDefault(kind: StepBlockKind): StepBlock {
  switch (kind) {
    case 'paragraph':
      return { kind: 'paragraph', text: '' };
    case 'callout':
      return { kind: 'callout', tone: 'note', text: '' };
    case 'bullet_list':
      return { kind: 'bullet_list', items: [''] };
    case 'numbered_list':
      return { kind: 'numbered_list', items: [''] };
    case 'key_value':
      return {
        kind: 'key_value',
        columns: ['Item', 'Value'],
        rows: [['', '']],
      };
    case 'photo_inline':
      return { kind: 'photo_inline', storageKey: '' };
  }
}

export function BlockListEditor({
  blocks,
  onChange,
  stepMedia,
  onUploadStepMedia,
  onDeleteStepMedia,
  legacyBodyMarkdown,
  onImportLegacy,
}: Props) {
  const [pickerAt, setPickerAt] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function setBlock(i: number, next: StepBlock) {
    const out = blocks.slice();
    out[i] = next;
    onChange(out);
  }
  function deleteBlock(i: number) {
    const out = blocks.slice();
    out.splice(i, 1);
    onChange(out);
  }
  function insertBlock(at: number, kind: StepBlockKind) {
    const out = blocks.slice();
    out.splice(at, 0, makeDefault(kind));
    onChange(out);
    setPickerAt(null);
  }
  function moveBlock(from: number, to: number) {
    if (from === to) return;
    const out = blocks.slice();
    const [m] = out.splice(from, 1);
    if (!m) return;
    out.splice(to, 0, m);
    onChange(out);
  }

  // Drag handlers — index-based (not id-based) since blocks are JSON, no
  // stable id. Works fine for short lists; we don't expect 100+ blocks.
  function onDragStart(i: number) {
    return (e: React.DragEvent) => {
      setDragIndex(i);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    };
  }
  function onDragOver(i: number) {
    return (e: React.DragEvent) => {
      if (dragIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropIndex !== i) setDropIndex(i);
    };
  }
  function onDrop(i: number) {
    return (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragIndex ?? Number(e.dataTransfer.getData('text/plain'));
      setDragIndex(null);
      setDropIndex(null);
      if (Number.isFinite(from)) moveBlock(from, i);
    };
  }
  function onDragEnd() {
    setDragIndex(null);
    setDropIndex(null);
  }

  const showLegacyImport =
    blocks.length === 0 &&
    !!legacyBodyMarkdown &&
    legacyBodyMarkdown.trim().length > 0 &&
    !!onImportLegacy;

  return (
    <div className="flex flex-col gap-1">
      {/* Empty state with legacy-markdown-import callout when relevant */}
      {blocks.length === 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-line bg-surface p-4">
          <p className="text-sm text-ink-secondary">
            No content yet. Add a block to start authoring.
          </p>
          <div className="flex flex-wrap gap-2">
            {BLOCK_PICKER.slice(0, 4).map((b) => (
              <button
                key={b.kind}
                type="button"
                onClick={() => insertBlock(0, b.kind)}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
              >
                <b.icon className="size-3.5" />
                {b.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPickerAt(0)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
            >
              <Plus className="size-3.5" />
              More
            </button>
          </div>
          {showLegacyImport && (
            <button
              type="button"
              onClick={onImportLegacy}
              className="mt-1 self-start text-xs font-medium text-accent hover:underline"
            >
              ↥ Import legacy markdown body as a paragraph
            </button>
          )}
        </div>
      )}

      {/* Top inline + button — only visible when blocks exist */}
      {blocks.length > 0 && (
        <InlineAddButton onClick={() => setPickerAt(0)} active={pickerAt === 0} />
      )}
      {pickerAt === 0 && (
        <BlockPicker
          onPick={(k) => insertBlock(0, k)}
          onDismiss={() => setPickerAt(null)}
        />
      )}

      {blocks.map((b, i) => (
        <div key={i}>
          <BlockShell
            block={b}
            index={i}
            onChange={(next) => setBlock(i, next)}
            onDelete={() => deleteBlock(i)}
            stepMedia={stepMedia}
            onUploadStepMedia={onUploadStepMedia}
            onDeleteStepMedia={onDeleteStepMedia}
            draggable={blocks.length > 1}
            onDragStart={onDragStart(i)}
            onDragOver={onDragOver(i)}
            onDrop={onDrop(i)}
            onDragEnd={onDragEnd}
            isDragging={dragIndex === i}
            isDropTarget={dropIndex === i && dragIndex !== i}
          />
          {/* Mid-list inline insertion stays hover-only — power-user
              affordance for inserting between existing blocks without
              cluttering every gap. The persistent button below the list
              handles the discoverable "add another" case. */}
          {i < blocks.length - 1 && (
            <>
              <InlineAddButton
                onClick={() => setPickerAt(i + 1)}
                active={pickerAt === i + 1}
              />
              {pickerAt === i + 1 && (
                <BlockPicker
                  onPick={(k) => insertBlock(i + 1, k)}
                  onDismiss={() => setPickerAt(null)}
                />
              )}
            </>
          )}
        </div>
      ))}

      {/* Always-visible "Add block" at the end of the list. The hover-
          revealed mid-list "+" was undiscoverable for first-time authors
          ("I added a photo and now I can't add a callout"). Mirrors the
          empty-state picker shape so the affordance feels consistent. */}
      {blocks.length > 0 && (
        <>
          {pickerAt === blocks.length ? (
            <BlockPicker
              onPick={(k) => insertBlock(blocks.length, k)}
              onDismiss={() => setPickerAt(null)}
            />
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
                Add block
              </span>
              {BLOCK_PICKER.slice(0, 4).map((b) => (
                <button
                  key={b.kind}
                  type="button"
                  onClick={() => insertBlock(blocks.length, b.kind)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line bg-surface px-2 py-1 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
                  title={`Add ${b.label}`}
                >
                  <b.icon className="size-3" />
                  {b.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPickerAt(blocks.length)}
                className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line bg-surface px-2 py-1 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
              >
                <Plus className="size-3" />
                More
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Block shell — common chrome: drag handle, kind chip, delete; renders
// the per-kind editor in the body slot.
// -------------------------------------------------------------------------

function BlockShell({
  block,
  index: _index,
  onChange,
  onDelete,
  stepMedia,
  onUploadStepMedia,
  onDeleteStepMedia,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDropTarget,
}: {
  block: StepBlock;
  index: number;
  onChange: (next: StepBlock) => void;
  onDelete: () => void;
  stepMedia: AdminStepMedia[];
  onUploadStepMedia?: (file: File) => Promise<AdminStepMedia>;
  onDeleteStepMedia?: (storageKey: string) => Promise<void>;
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  const meta = BLOCK_PICKER.find((b) => b.kind === block.kind)!;
  const Icon = meta.icon;

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={[
        'group/blk relative my-1 flex items-stretch gap-2 rounded-md border bg-surface-raised transition',
        'border-line-subtle hover:border-line',
        isDragging ? 'opacity-50' : '',
        isDropTarget ? 'ring-2 ring-accent/60 ring-offset-1 ring-offset-surface' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex shrink-0 flex-col items-center gap-1 px-1.5 pt-2 text-ink-tertiary">
        <button
          type="button"
          aria-label="Drag block"
          className={`cursor-grab transition hover:text-ink-primary active:cursor-grabbing ${
            !draggable ? 'opacity-30 pointer-events-none' : ''
          }`}
          tabIndex={-1}
        >
          <GripVertical className="size-4" />
        </button>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 py-2.5 pr-2">
        <BlockBody
          block={block}
          onChange={onChange}
          stepMedia={stepMedia}
          onUploadStepMedia={onUploadStepMedia}
          onDeleteStepMedia={onDeleteStepMedia}
        />
      </div>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete block"
        title="Delete block"
        className="m-1 self-start rounded p-1 text-ink-tertiary opacity-0 transition group-hover/blk:opacity-100 hover:bg-signal-fault/10 hover:text-signal-fault"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function BlockBody({
  block,
  onChange,
  stepMedia,
  onUploadStepMedia,
  onDeleteStepMedia,
}: {
  block: StepBlock;
  onChange: (next: StepBlock) => void;
  stepMedia: AdminStepMedia[];
  onUploadStepMedia?: (file: File) => Promise<AdminStepMedia>;
  onDeleteStepMedia?: (storageKey: string) => Promise<void>;
}) {
  switch (block.kind) {
    case 'paragraph':
      return <ParagraphEditor block={block} onChange={onChange} />;
    case 'callout':
      return <CalloutEditor block={block} onChange={onChange} />;
    case 'bullet_list':
    case 'numbered_list':
      return <ListEditor block={block} onChange={onChange} />;
    case 'key_value':
      return <KeyValueEditor block={block} onChange={onChange} />;
    case 'photo_inline':
      return (
        <PhotoInlineEditor
          block={block}
          onChange={onChange}
          stepMedia={stepMedia}
          onUploadStepMedia={onUploadStepMedia}
          onDeleteStepMedia={onDeleteStepMedia}
        />
      );
  }
}

// -------------------------------------------------------------------------
// Per-kind editors
// -------------------------------------------------------------------------

function ParagraphEditor({
  block,
  onChange,
}: {
  block: Extract<StepBlock, { kind: 'paragraph' }>;
  onChange: (next: StepBlock) => void;
}) {
  return (
    <AutoTextarea
      value={block.text}
      onChange={(v) => onChange({ ...block, text: v })}
      placeholder="Write a paragraph. Plain text — links auto-detect."
      minRows={2}
    />
  );
}

const TONE_OPTIONS: Array<{
  value: 'safety' | 'warning' | 'tip' | 'note';
  label: string;
  icon: typeof ShieldAlert;
}> = [
  { value: 'safety', label: 'Safety', icon: ShieldAlert },
  { value: 'warning', label: 'Warning', icon: AlertTriangle },
  { value: 'tip', label: 'Tip', icon: Lightbulb },
  { value: 'note', label: 'Note', icon: Info },
];

function CalloutEditor({
  block,
  onChange,
}: {
  block: Extract<StepBlock, { kind: 'callout' }>;
  onChange: (next: StepBlock) => void;
}) {
  const tone = TONE_OPTIONS.find((t) => t.value === block.tone) ?? TONE_OPTIONS[3];
  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit rounded-md border border-line-subtle bg-surface p-0.5">
        {TONE_OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = value === block.tone;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ ...block, tone: value })}
              className={[
                'inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition',
                active
                  ? value === 'safety'
                    ? 'bg-signal-warn text-white'
                    : value === 'warning'
                      ? 'bg-signal-warn/80 text-white'
                      : value === 'tip'
                        ? 'bg-signal-info text-white'
                        : 'bg-ink-secondary text-white'
                  : 'text-ink-secondary hover:text-ink-primary',
              ].join(' ')}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        value={block.title ?? ''}
        onChange={(e) =>
          onChange({ ...block, title: e.target.value || undefined })
        }
        placeholder={`${tone!.label} title (optional)`}
        className="w-full bg-transparent text-sm font-semibold text-ink-primary outline-none placeholder:text-ink-tertiary/60"
      />
      <AutoTextarea
        value={block.text}
        onChange={(v) => onChange({ ...block, text: v })}
        placeholder={`What should the tech know? — e.g., "Voltage may persist for 30 seconds after isolation."`}
        minRows={2}
      />
    </div>
  );
}

function ListEditor({
  block,
  onChange,
}: {
  block: Extract<StepBlock, { kind: 'bullet_list' | 'numbered_list' }>;
  onChange: (next: StepBlock) => void;
}) {
  function setItem(i: number, v: string) {
    const items = block.items.slice();
    items[i] = v;
    onChange({ ...block, items });
  }
  function addItem() {
    onChange({ ...block, items: [...block.items, ''] });
  }
  function removeItem(i: number) {
    if (block.items.length <= 1) return;
    const items = block.items.slice();
    items.splice(i, 1);
    onChange({ ...block, items });
  }
  return (
    <div className="flex flex-col gap-1.5">
      {block.items.map((it, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full bg-ink-tertiary" />
          <input
            type="text"
            value={it}
            onChange={(e) => setItem(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                addItem();
              }
              if (e.key === 'Backspace' && it === '' && block.items.length > 1) {
                e.preventDefault();
                removeItem(i);
              }
            }}
            placeholder={i === 0 ? 'List item — press Enter for the next' : ''}
            className="w-full bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-tertiary/60"
          />
          {block.items.length > 1 && (
            <button
              type="button"
              onClick={() => removeItem(i)}
              aria-label="Remove item"
              className="rounded p-0.5 text-ink-tertiary opacity-0 transition hover:bg-signal-fault/10 hover:text-signal-fault group-hover/blk:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="self-start text-xs font-medium text-ink-tertiary transition hover:text-accent"
      >
        + Add item
      </button>
    </div>
  );
}

function KeyValueEditor({
  block,
  onChange,
}: {
  block: Extract<StepBlock, { kind: 'key_value' }>;
  onChange: (next: StepBlock) => void;
}) {
  function setColumn(i: 0 | 1, v: string) {
    const columns = [...block.columns] as [string, string];
    columns[i] = v;
    onChange({ ...block, columns });
  }
  function setRow(rowIdx: number, colIdx: 0 | 1, v: string) {
    const rows = block.rows.map((r) => [...r] as [string, string]);
    rows[rowIdx]![colIdx] = v;
    onChange({ ...block, rows });
  }
  function addRow() {
    onChange({ ...block, rows: [...block.rows, ['', '']] });
  }
  function removeRow(i: number) {
    if (block.rows.length <= 1) return;
    const rows = block.rows.slice();
    rows.splice(i, 1);
    onChange({ ...block, rows });
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        <input
          type="text"
          value={block.columns[0]}
          onChange={(e) => setColumn(0, e.target.value)}
          placeholder="Column 1"
          className="w-1/2 rounded-sm border-b border-line-subtle bg-transparent px-2 py-1 text-xs font-semibold uppercase tracking-wider text-ink-secondary outline-none focus:border-accent"
        />
        <input
          type="text"
          value={block.columns[1]}
          onChange={(e) => setColumn(1, e.target.value)}
          placeholder="Column 2"
          className="w-1/2 rounded-sm border-b border-line-subtle bg-transparent px-2 py-1 text-xs font-semibold uppercase tracking-wider text-ink-secondary outline-none focus:border-accent"
        />
      </div>
      {block.rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={row[0]}
            onChange={(e) => setRow(i, 0, e.target.value)}
            placeholder="—"
            className="w-1/2 rounded-sm border border-line-subtle bg-surface px-2 py-1 text-sm text-ink-primary outline-none focus:border-accent"
          />
          <input
            type="text"
            value={row[1]}
            onChange={(e) => setRow(i, 1, e.target.value)}
            placeholder="—"
            className="w-1/2 rounded-sm border border-line-subtle bg-surface px-2 py-1 text-sm text-ink-primary outline-none focus:border-accent"
          />
          {block.rows.length > 1 && (
            <button
              type="button"
              onClick={() => removeRow(i)}
              aria-label="Remove row"
              className="rounded p-0.5 text-ink-tertiary transition hover:bg-signal-fault/10 hover:text-signal-fault"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="self-start text-xs font-medium text-ink-tertiary transition hover:text-accent"
      >
        + Add row
      </button>
    </div>
  );
}

function PhotoInlineEditor({
  block,
  onChange,
  stepMedia,
  onUploadStepMedia,
  onDeleteStepMedia,
}: {
  block: Extract<StepBlock, { kind: 'photo_inline' }>;
  onChange: (next: StepBlock) => void;
  stepMedia: AdminStepMedia[];
  onUploadStepMedia?: (file: File) => Promise<AdminStepMedia>;
  onDeleteStepMedia?: (storageKey: string) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const replaceRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const images = stepMedia.filter((m) => m.kind === 'image');
  const selected = images.find((m) => m.storageKey === block.storageKey);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !onUploadStepMedia) return;
    setUploading(true);
    setUploadError(null);
    try {
      const item = await onUploadStepMedia(file);
      // Auto-select the freshly uploaded photo so the author doesn't have
      // to click a second time. The parent's stepMedia prop will re-render
      // with the new item on next render — selection by storageKey works
      // in both cases.
      onChange({ ...block, storageKey: item.storageKey });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  // Replace = upload a new image, point this block at it, and remove the old
  // one from the step so swapping doesn't leave the original behind.
  async function onPickReplaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !onUploadStepMedia) return;
    const oldKey = block.storageKey;
    setUploading(true);
    setUploadError(null);
    try {
      const item = await onUploadStepMedia(file);
      onChange({ ...block, storageKey: item.storageKey });
      if (oldKey && oldKey !== item.storageKey && onDeleteStepMedia) {
        await onDeleteStepMedia(oldKey);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  // Remove an image from the step entirely. If it was the one this block
  // showed, deselect so the block doesn't point at a deleted key.
  async function removeImage(storageKey: string) {
    if (!onDeleteStepMedia) return;
    setUploading(true);
    setUploadError(null);
    try {
      await onDeleteStepMedia(storageKey);
      if (block.storageKey === storageKey) onChange({ ...block, storageKey: '' });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {images.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-ink-tertiary">
            No photos on this step yet — upload one to insert it here.
          </p>
          {onUploadStepMedia && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs font-medium text-accent transition hover:border-accent hover:bg-accent/10 disabled:opacity-50"
            >
              {uploading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Uploading…
                </>
              ) : (
                <>
                  <Upload className="size-3.5" /> Upload photo
                </>
              )}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((m) => {
              const active = m.storageKey === block.storageKey;
              return (
                <div key={m.storageKey} className="group/img relative">
                  <button
                    type="button"
                    onClick={() => onChange({ ...block, storageKey: m.storageKey })}
                    className={[
                      'relative block aspect-video w-full overflow-hidden rounded-md border transition',
                      active
                        ? 'border-accent ring-2 ring-accent/40'
                        : 'border-line hover:border-accent/40',
                    ].join(' ')}
                  >
                    {m.url ? (
                      <img src={m.url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center bg-surface text-xs text-ink-tertiary">
                        No preview
                      </div>
                    )}
                  </button>
                  {onDeleteStepMedia && (
                    <button
                      type="button"
                      onClick={() => void removeImage(m.storageKey)}
                      disabled={uploading}
                      aria-label="Remove photo from step"
                      title="Remove photo from step"
                      className="absolute right-1 top-1 rounded bg-surface/90 p-0.5 text-ink-tertiary opacity-0 shadow transition group-hover/img:opacity-100 hover:text-signal-fault disabled:opacity-50"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
              );
            })}
            {onUploadStepMedia && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex aspect-video flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line text-xs text-ink-tertiary transition hover:border-accent/60 hover:bg-accent/5 hover:text-accent disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    <Upload className="size-4" />
                    <span>Upload</span>
                  </>
                )}
              </button>
            )}
          </div>
          {selected && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={block.caption ?? ''}
                onChange={(e) =>
                  onChange({ ...block, caption: e.target.value || undefined })
                }
                placeholder="Caption (optional)"
                className="min-w-0 flex-1 rounded-sm border border-line-subtle bg-surface px-2 py-1 text-xs text-ink-secondary outline-none focus:border-accent"
              />
              {onUploadStepMedia && (
                <button
                  type="button"
                  onClick={() => replaceRef.current?.click()}
                  disabled={uploading}
                  title="Upload a new image and remove this one"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-secondary transition hover:border-accent/50 hover:text-accent disabled:opacity-50"
                >
                  <Upload className="size-3.5" /> Replace
                </button>
              )}
            </div>
          )}
        </>
      )}
      {uploadError && (
        <p className="rounded-md border border-signal-fault/40 bg-signal-fault/10 px-2 py-1 text-xs text-signal-fault">
          {uploadError}
        </p>
      )}
      <input
        ref={replaceRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/heic,image/heif"
        onChange={onPickReplaceFile}
        className="hidden"
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/heic,image/heif"
        onChange={onPickFile}
        className="hidden"
      />
    </div>
  );
}

// -------------------------------------------------------------------------
// Inline + button + block picker menu
// -------------------------------------------------------------------------

function InlineAddButton({
  onClick,
  active,
}: {
  onClick: () => void;
  active: boolean;
}) {
  return (
    <div className="group/add relative h-2">
      <button
        type="button"
        onClick={onClick}
        aria-label="Add block"
        className={[
          'absolute inset-x-0 top-1/2 -translate-y-1/2',
          'flex h-5 items-center justify-center',
          'transition',
          active ? 'opacity-100' : 'opacity-0 group-hover/add:opacity-100',
        ].join(' ')}
      >
        <span className="h-px flex-1 bg-line transition group-hover/add:bg-accent/50" />
        <span
          className={[
            'mx-2 inline-flex size-5 items-center justify-center rounded-full bg-surface-raised text-ink-tertiary shadow-sm transition',
            'group-hover/add:bg-accent group-hover/add:text-white',
            active ? 'bg-accent text-white' : '',
          ].join(' ')}
        >
          <Plus className="size-3" />
        </span>
        <span className="h-px flex-1 bg-line transition group-hover/add:bg-accent/50" />
      </button>
    </div>
  );
}

function BlockPicker({
  onPick,
  onDismiss,
}: {
  onPick: (k: StepBlockKind) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Click-outside / Escape to dismiss.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    function onMouse(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onDismiss();
    }
    window.addEventListener('keydown', onKey);
    setTimeout(() => window.addEventListener('mousedown', onMouse), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
    };
  }, [onDismiss]);
  return (
    <div
      ref={ref}
      className="my-1 overflow-hidden rounded-md border border-line bg-surface-raised shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-line-subtle bg-surface px-3 py-1.5">
        <ChevronDown className="size-3 text-ink-tertiary" />
        <span className="text-xs font-medium uppercase tracking-wider text-ink-tertiary">
          Pick a block
        </span>
      </div>
      <ul className="flex flex-col">
        {BLOCK_PICKER.map(({ kind, label, description, icon: Icon }) => (
          <li key={kind}>
            <button
              type="button"
              onClick={() => onPick(kind)}
              className="flex w-full items-start gap-3 px-3 py-2 text-left transition hover:bg-accent/5"
            >
              <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-surface text-ink-secondary">
                <Icon className="size-3.5" />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium text-ink-primary">
                  {label}
                </span>
                <span className="block text-xs text-ink-tertiary">
                  {description}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------------------
// Auto-resizing textarea — used by paragraph + callout body. Keeps the
// editor feeling like prose, not a fixed-height form field.
// -------------------------------------------------------------------------

function AutoTextarea({
  value,
  onChange,
  placeholder,
  minRows = 1,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={minRows}
      className="w-full resize-none bg-transparent text-sm leading-relaxed text-ink-primary outline-none placeholder:text-ink-tertiary/60"
    />
  );
}
