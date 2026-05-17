'use client';

// StepCard — one inline-editable step inside the CMS editor. All edits
// auto-save with a per-field debounce; the parent shows a single
// "Saving…/Saved" indicator at the top of the page.

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Film,
  GripVertical,
  ListChecks,
  MoreVertical,
  Ruler,
  ShieldAlert,
  Trash2,
  Upload as UploadIcon,
} from 'lucide-react';
import {
  uploadProcedureStepMedia,
  deleteProcedureStepMedia,
  type AdminProcedureSection,
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
  /** Available sections for the kebab menu's "Move to section" picker.
   *  When omitted/empty the picker isn't shown. */
  sections?: AdminProcedureSection[];
  /** Move this step into a different section (or null for ungrouped). */
  onMoveToSection?: (sectionId: string | null) => void | Promise<void>;
  /** Default-expand the card on first mount. Pass true for newly-added
   *  steps so the author can type immediately; everything else stays
   *  collapsed so a long procedure stays scannable. */
  defaultExpanded?: boolean;
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
  sections,
  onMoveToSection,
  defaultExpanded = false,
}: Props) {
  // Collapsed by default — see Props.defaultExpanded. Authors scan dozens
  // of steps; only one is being actively edited at any moment, so the
  // collapsed row keeps the editing surface tight without losing context.
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
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
  // Tracks the most recent value we shipped upstream. When step.title
  // changes back to us via the parent re-fetch, we compare it to this:
  // if it matches what we sent, the update is our own echo — leave
  // local state alone (the user may have typed more characters during
  // the round-trip). Without this, the useEffect below clobbers in-
  // flight typing on every save, which felt like "deleted characters".
  const lastSentTitleRef = useRef(step.title);

  // If the parent reloads the step (e.g. after audio update), keep the
  // local mirrors aligned UNLESS the user has unsaved edits. The parent
  // typically reloads only on shape-changing mutations.
  useEffect(() => {
    if (step.title !== lastSentTitleRef.current) {
      // Server / another editor changed the title to something we didn't
      // send — accept it. Most common path: switching to a different
      // step (step.id changes) which legitimately needs the new title.
      setTitle(step.title);
      lastSentTitleRef.current = step.title;
    }
    setBlocks(step.blocks ?? []);
    setKind(step.kind);
    setSafetyCritical(step.safetyCritical);
  }, [step.id, step.updatedAt]);

  function onTitleChange(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      const v = next.trim();
      if (v && v !== step.title) {
        lastSentTitleRef.current = v;
        void onPatch({ title: v });
      }
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
        if (v && v !== step.title) {
          lastSentTitleRef.current = v;
          void onPatch({ title: v });
        }
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

  const KindMeta =
    KIND_OPTIONS.find((k) => k.value === kind) ?? KIND_OPTIONS[0]!;
  const KindIcon = KindMeta.icon;
  const photoCount = (step.media ?? []).filter((m) => m.kind === 'image').length;
  const videoCount = (step.media ?? []).filter((m) => m.kind === 'video').length;
  const hasVoiceover = !!step.audioUrl;
  const titlePreview = title.trim() || 'Untitled step';

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
        expanded ? 'shadow-sm' : 'hover:border-line',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* COLLAPSED VIEW — the default. One quiet row per step so a 50-step
          procedure scrolls without overwhelming. Click anywhere on the row
          (outside the drag handle / kebab) to expand. */}
      {!expanded && (
        <div
          className="flex items-center gap-3 px-3 py-2.5 cursor-pointer"
          onClick={() => setExpanded(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded(true);
            }
          }}
        >
          <span
            className="cursor-grab text-ink-tertiary/60 hover:text-ink-primary active:cursor-grabbing shrink-0"
            onClick={(e) => e.stopPropagation()}
            title="Drag to reorder"
          >
            <GripVertical className="size-4" />
          </span>
          <span className="font-mono text-xs font-semibold tabular-nums text-ink-tertiary shrink-0 w-7 text-right">
            {String(index + 1).padStart(2, '0')}
          </span>
          <KindIcon className="size-3.5 text-ink-tertiary shrink-0" />
          <span
            className={[
              'flex-1 truncate text-sm',
              title.trim()
                ? 'text-ink-primary'
                : 'italic text-ink-tertiary/70',
            ].join(' ')}
          >
            {titlePreview}
          </span>
          {/* Quiet status pills — only render when set. Keeps the row
              uncluttered for plain instruction steps. */}
          {safetyCritical && (
            <ShieldAlert
              className="size-3.5 text-signal-warn shrink-0"
              aria-label="Safety-critical"
            />
          )}
          {photoCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-ink-tertiary shrink-0"
              title={`${photoCount} photo${photoCount === 1 ? '' : 's'}`}
            >
              <Camera className="size-3" /> {photoCount}
            </span>
          )}
          {videoCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-ink-tertiary shrink-0"
              title={`${videoCount} video${videoCount === 1 ? '' : 's'}`}
            >
              <Film className="size-3" /> {videoCount}
            </span>
          )}
          {hasVoiceover && (
            <span
              className="text-[10px] text-ink-tertiary shrink-0"
              title="Voiceover attached"
            >
              🎧
            </span>
          )}
          <div onClick={(e) => e.stopPropagation()} className="shrink-0">
            <StepKebabMenu
              sections={sections ?? []}
              currentSectionId={step.sectionId}
              onMoveToSection={onMoveToSection}
              onDelete={() => void onDelete()}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
            className="shrink-0 rounded p-1 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Expand step"
            title="Expand"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      )}

      {/* EXPANDED VIEW */}
      {expanded && (
        <>
          {/* Tightened header — single kind dropdown, icon-only safety
              toggle, kebab menu, collapse caret. */}
          <header className="flex items-center gap-2 border-b border-line-subtle px-3 py-2">
            <span
              className="cursor-grab text-ink-tertiary/60 hover:text-ink-primary active:cursor-grabbing"
              title="Drag to reorder"
            >
              <GripVertical className="size-4" />
            </span>
            <span className="font-mono text-xs font-semibold tabular-nums text-ink-tertiary w-7 text-right">
              {String(index + 1).padStart(2, '0')}
              <span className="text-ink-tertiary/50">
                /{String(totalSteps).padStart(2, '0')}
              </span>
            </span>
            <select
              value={kind}
              onChange={(e) => onKindChange(e.target.value as ProcedureStepKind)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-ink-primary"
              title="Step kind"
            >
              {KIND_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSafetyToggle(!safetyCritical)}
                aria-label={
                  safetyCritical
                    ? 'Unmark safety-critical'
                    : 'Mark safety-critical'
                }
                title={
                  safetyCritical ? 'Safety-critical' : 'Mark as safety-critical'
                }
                className={[
                  'rounded p-1.5 transition',
                  safetyCritical
                    ? 'bg-signal-warn/15 text-signal-warn'
                    : 'text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary',
                ].join(' ')}
              >
                <ShieldAlert className="size-4" />
              </button>
              <StepKebabMenu
                sections={sections ?? []}
                currentSectionId={step.sectionId}
                onMoveToSection={onMoveToSection}
                onDelete={() => void onDelete()}
              />
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded p-1.5 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
                aria-label="Collapse step"
                title="Collapse"
              >
                <ChevronUp className="size-4" />
              </button>
            </div>
          </header>

          {/* Body — title, structured block list, media, voiceover. Inline
              forms only; no drawers, no modals. The voiceover and step-
              videos panels each manage their own empty/non-empty states
              to keep this card terse when there's no media attached. */}
          <div className="flex flex-col gap-3 p-3">
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Short imperative — e.g., Apply LOTO and verify zero energy"
              className="w-full bg-transparent text-lg font-semibold text-ink-primary outline-none placeholder:text-ink-tertiary/60 focus:placeholder:text-ink-tertiary/40"
              autoFocus={defaultExpanded}
            />

            <BlockListEditor
              blocks={blocks}
              onChange={onBlocksChange}
              stepMedia={step.media ?? []}
              onUploadStepMedia={async (file) => {
                const item = await uploadProcedureStepMedia(step.id, file);
                // Optimistically merge into the step so the picker shows it
                // before the parent's next refresh.
                const nextMedia: AdminStepMedia[] = [
                  ...(step.media ?? []),
                  item,
                ];
                onAudioChanged({ ...step, media: nextMedia });
                return item;
              }}
              legacyBodyMarkdown={step.bodyMarkdown}
              onImportLegacy={onImportLegacy}
            />

            <StepVideosPanel step={step} onChanged={onAudioChanged} />

            <VoiceoverPanel step={step} onChanged={onAudioChanged} />
          </div>
        </>
      )}
    </li>
  );
}

// Lightweight popover-style menu attached to a kebab (⋮) trigger. Used in
// both the collapsed and expanded step views — keeps infrequent actions
// (Move to section, Delete) out of the always-visible header. Closes on
// outside click and on Escape.
function StepKebabMenu({
  sections,
  currentSectionId,
  onMoveToSection,
  onDelete,
}: {
  sections: AdminProcedureSection[];
  currentSectionId: string | null;
  onMoveToSection?: (sectionId: string | null) => void | Promise<void>;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sortedSections = [...sections].sort(
    (a, b) => a.orderingHint - b.orderingHint,
  );
  const showMove = !!onMoveToSection && sortedSections.length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Step actions"
        className="rounded p-1.5 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
        title="More actions"
      >
        <MoreVertical className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-md border border-line bg-surface-raised shadow-lg"
        >
          {showMove && (
            <>
              <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
                Move to section
              </p>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void onMoveToSection?.(null);
                }}
                className={[
                  'block w-full px-3 py-1.5 text-left text-sm transition hover:bg-surface-elevated',
                  currentSectionId === null
                    ? 'font-semibold text-accent'
                    : 'text-ink-primary',
                ].join(' ')}
              >
                — Ungrouped (top) —
              </button>
              {sortedSections.map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    void onMoveToSection?.(sec.id);
                  }}
                  className={[
                    'block w-full truncate px-3 py-1.5 text-left text-sm transition hover:bg-surface-elevated',
                    currentSectionId === sec.id
                      ? 'font-semibold text-accent'
                      : 'text-ink-primary',
                  ].join(' ')}
                >
                  {sec.title}
                </button>
              ))}
              <hr className="my-1 border-line-subtle" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-signal-fault transition hover:bg-signal-fault/10"
          >
            <Trash2 className="size-3.5" /> Delete step
          </button>
        </div>
      )}
    </div>
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

// StepVideosPanel — uploads + manages videos attached to a single step.
// Videos land in step.media (kind='video') but DON'T get a photo_inline
// block — they're displayed in the PWA's trailing media gallery,
// separate from inline photos that interleave with prose.
function StepVideosPanel({
  step,
  onChanged,
}: {
  step: AdminProcedureStep;
  onChanged: (next: AdminProcedureStep) => void;
}) {
  const [busy, setBusy] = useState<string | true | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videos = (step.media ?? []).filter((m) => m.kind === 'video');

  async function onPick(file: File) {
    setBusy(true);
    setError(null);
    try {
      if (!file.type.startsWith('video/')) {
        throw new Error('Please choose a video file.');
      }
      const item = await uploadProcedureStepMedia(step.id, file);
      onChanged({
        ...step,
        media: [...(step.media ?? []), item],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRemove(storageKey: string) {
    setBusy(storageKey);
    setError(null);
    try {
      await deleteProcedureStepMedia(step.id, storageKey);
      onChanged({
        ...step,
        media: (step.media ?? []).filter((m) => m.storageKey !== storageKey),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-md border border-line-subtle bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <Film className="size-3.5 text-ink-tertiary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          Step videos
        </span>
        <span className="text-xs text-ink-tertiary">
          {videos.length === 0
            ? 'optional'
            : `${videos.length} attached`}
        </span>
      </div>
      {error && (
        <p className="mb-2 text-xs text-signal-fault" role="alert">
          {error}
        </p>
      )}
      {videos.length > 0 && (
        <ul className="mb-2 flex flex-col gap-2">
          {videos.map((v) => (
            <li
              key={v.storageKey}
              className="flex items-center gap-3 rounded border border-line-subtle bg-surface-raised px-2.5 py-2"
            >
              {v.url ? (
                <video
                  src={v.url}
                  preload="metadata"
                  className="aspect-video h-12 rounded bg-black"
                  muted
                />
              ) : (
                <div className="grid aspect-video h-12 place-items-center rounded bg-surface-elevated text-ink-tertiary">
                  <Film className="size-3.5" />
                </div>
              )}
              <div className="flex-1 truncate text-xs text-ink-secondary">
                {v.caption || v.mime}
              </div>
              <button
                type="button"
                onClick={() => onRemove(v.storageKey)}
                disabled={busy === v.storageKey}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault disabled:opacity-50"
                aria-label="Remove video"
                title="Remove video"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 ${
          busy === true ? 'pointer-events-none opacity-50' : ''
        }`}
      >
        <UploadIcon className="size-3.5" />
        {busy === true ? 'Uploading…' : 'Add video'}
        <input
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = '';
          }}
          className="hidden"
          disabled={busy === true}
        />
      </label>
    </div>
  );
}
