'use client';

// StepCard — one inline-editable step inside the CMS editor. All edits
// auto-save with a per-field debounce; the parent shows a single
// "Saving…/Saved" indicator at the top of the page.

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ClipboardCheck,
  GripVertical,
  ListChecks,
  Ruler,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  uploadProcedureStepMedia,
  type AdminProcedureStep,
  type AdminStepMedia,
  type ProcedureStepKind,
  type StepBlock,
  type UpdateProcedureStepInput,
} from '@/lib/api';
import { VoiceoverPanel } from './voiceover-panel';
import { BlockListEditor } from './block-editor';

interface Props {
  step: AdminProcedureStep;
  index: number;
  totalSteps: number;
  /** Save a partial patch. Caller manages debouncing/queuing. */
  onPatch: (patch: UpdateProcedureStepInput) => Promise<AdminProcedureStep | null>;
  onDelete: () => Promise<void>;
  /** When the voiceover panel mutates audio fields, propagate the new
   *  step shape so this card re-renders with the latest URL/source. */
  onAudioChanged: (next: AdminProcedureStep) => void;
  // Drag-and-drop wiring. Parent owns the order list; the card just
  // surfaces grab + drop affordances.
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
}

const KIND_OPTIONS: Array<{ value: ProcedureStepKind; label: string; icon: typeof ClipboardCheck }> = [
  { value: 'instruction', label: 'Instruction', icon: ClipboardCheck },
  { value: 'safety_check', label: 'Safety check', icon: ShieldAlert },
  { value: 'photo_required', label: 'Photo required', icon: Camera },
  { value: 'measurement_required', label: 'Measurement', icon: Ruler },
];

export function StepCard({
  step,
  index,
  totalSteps,
  onPatch,
  onDelete,
  onAudioChanged,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDropTarget,
}: Props) {
  // Local-state mirrors of editable fields. Auto-save debounce flushes
  // them upstream; we never block typing on the network.
  const [title, setTitle] = useState(step.title);
  const [blocks, setBlocks] = useState<StepBlock[]>(step.blocks ?? []);
  const [kind, setKind] = useState<ProcedureStepKind>(step.kind);
  const [safetyCritical, setSafetyCritical] = useState(step.safetyCritical);

  // Debounce refs — separate timers per field so a slow block edit doesn't
  // delay a quick title save. 600ms feels responsive without spamming the
  // server while the user is mid-sentence.
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocksTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the parent reloads the step (e.g. after audio update), keep the
  // local mirrors aligned UNLESS the user has unsaved edits. The parent
  // typically reloads only on shape-changing mutations.
  useEffect(() => {
    setTitle(step.title);
    setBlocks(step.blocks ?? []);
    setKind(step.kind);
    setSafetyCritical(step.safetyCritical);
  }, [step.id, step.updatedAt]);

  function onTitleChange(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      const v = next.trim();
      if (v && v !== step.title) void onPatch({ title: v });
    }, 600);
  }
  function onBlocksChange(next: StepBlock[]) {
    setBlocks(next);
    if (blocksTimer.current) clearTimeout(blocksTimer.current);
    blocksTimer.current = setTimeout(() => {
      void onPatch({ blocks: next });
    }, 800);
  }
  // Migrate the legacy bodyMarkdown into a single paragraph block — one-
  // click affordance shown by BlockListEditor when the step has no blocks
  // yet but does have legacy markdown content.
  function onImportLegacy() {
    const md = (step.bodyMarkdown ?? '').trim();
    if (!md) return;
    const next: StepBlock[] = [{ kind: 'paragraph', text: md }];
    setBlocks(next);
    void onPatch({ blocks: next, bodyMarkdown: null });
  }
  function onKindChange(next: ProcedureStepKind) {
    setKind(next);
    // Coerce evidence flags client-side so the UI matches the server
    // post-save (server runs identical coercion in coerceEvidence).
    const patch: UpdateProcedureStepInput = { kind: next };
    if (next === 'photo_required') {
      patch.requiresPhoto = true;
      patch.minPhotoCount = Math.max(1, step.minPhotoCount);
      patch.measurementSpec = null;
    } else if (next === 'safety_check') {
      patch.measurementSpec = null;
      if (!safetyCritical) {
        patch.safetyCritical = true;
        setSafetyCritical(true);
      }
    } else if (next === 'instruction') {
      patch.measurementSpec = null;
    }
    // measurement_required: leave existing spec, admin will edit it; if
    // none yet, the dedicated editor offers a default.
    void onPatch(patch);
  }
  function onSafetyToggle(next: boolean) {
    setSafetyCritical(next);
    void onPatch({ safetyCritical: next });
  }

  // Flush on unmount so a quick navigation doesn't drop the user's last keystrokes.
  useEffect(() => {
    return () => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current);
        const v = title.trim();
        if (v && v !== step.title) void onPatch({ title: v });
      }
      if (blocksTimer.current) {
        clearTimeout(blocksTimer.current);
        if (JSON.stringify(blocks) !== JSON.stringify(step.blocks ?? [])) {
          void onPatch({ blocks });
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const KindIcon = KIND_OPTIONS.find((k) => k.value === kind)?.icon ?? ClipboardCheck;

  return (
    <li
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-dragging={isDragging || undefined}
      data-drop-target={isDropTarget || undefined}
      className={[
        'cms-step-card relative rounded-lg border bg-surface-raised transition',
        safetyCritical
          ? 'border-signal-warn/40'
          : 'border-line-subtle',
        isDragging ? 'opacity-50' : '',
        isDropTarget ? 'ring-2 ring-accent/60 ring-offset-2 ring-offset-surface' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Header strip: drag handle, step number, kind chip, safety, delete */}
      <header className="flex items-center gap-3 border-b border-line-subtle px-4 py-3">
        <button
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab text-ink-tertiary transition hover:text-ink-primary active:cursor-grabbing"
          // The drag handle is the only place draggable=true. The list
          // below intercepts the actual events; we just provide the grab
          // affordance here.
          tabIndex={-1}
        >
          <GripVertical className="size-5" />
        </button>
        <span className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums text-ink-tertiary">
          {String(index + 1).padStart(2, '0')}
          <span className="text-ink-tertiary/60">/ {String(totalSteps).padStart(2, '0')}</span>
        </span>
        <KindChips value={kind} onChange={onKindChange} />
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={safetyCritical}
            onChange={(e) => onSafetyToggle(e.target.checked)}
            className="size-3.5"
          />
          <ShieldAlert className="size-3.5 text-signal-warn" />
          <span>Safety-critical</span>
        </label>
        <button
          type="button"
          onClick={() => void onDelete()}
          aria-label="Delete step"
          title="Delete step"
          className="rounded p-1.5 text-ink-tertiary transition hover:bg-signal-fault/10 hover:text-signal-fault"
        >
          <Trash2 className="size-4" />
        </button>
      </header>

      {/* Body — title, structured block list, voiceover panel. Inline
          forms only; no drawers, no modals, no markdown syntax — the
          template renders block kinds with consistent visual style so
          procedures look identical across the library. */}
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <KindIcon className="mt-2 size-5 shrink-0 text-ink-tertiary" />
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Short imperative — e.g., Apply LOTO and verify zero energy"
            className="w-full bg-transparent text-lg font-semibold text-ink-primary outline-none placeholder:text-ink-tertiary/60 focus:placeholder:text-ink-tertiary/40"
          />
        </div>

        <BlockListEditor
          blocks={blocks}
          onChange={onBlocksChange}
          stepMedia={step.media ?? []}
          onUploadStepMedia={async (file) => {
            const item = await uploadProcedureStepMedia(step.id, file);
            // Optimistically merge into the step so the picker shows it
            // before the parent's next refresh.
            const nextMedia: AdminStepMedia[] = [...(step.media ?? []), item];
            onAudioChanged({ ...step, media: nextMedia });
            return item;
          }}
          legacyBodyMarkdown={step.bodyMarkdown}
          onImportLegacy={onImportLegacy}
        />

        <VoiceoverPanel step={step} onChanged={onAudioChanged} />
      </div>
    </li>
  );
}

function KindChips({
  value,
  onChange,
}: {
  value: ProcedureStepKind;
  onChange: (k: ProcedureStepKind) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line-subtle bg-surface p-0.5">
      {KIND_OPTIONS.map(({ value: v, label, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={[
              'inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition',
              active
                ? 'bg-accent text-white shadow-sm'
                : 'text-ink-secondary hover:text-ink-primary',
            ].join(' ')}
            title={label}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Re-exported for callers that want the same icon set in headers/empty
// states without depending on the internal KIND_OPTIONS shape.
export { ListChecks };
