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
  Globe2,
  GripVertical,
  Link2,
  ListChecks,
  MoreVertical,
  Puzzle,
  Ruler,
  ShieldAlert,
  Trash2,
  Unlink2,
  Upload as UploadIcon,
} from 'lucide-react';
import {
  uploadProcedureStepMedia,
  deleteProcedureStepMedia,
  type AdminProcedureSection,
  type AdminProcedureStep,
  type AdminProcedureStepCategory,
  type AdminSiblingProcedure,
  type AdminStepMedia,
  type ProcedureStepKind,
  type StepBlock,
  type UpdateProcedureStepInput,
} from '@/lib/api';
import { VoiceoverPanel } from './voiceover-panel';
import { BlockListEditor } from './block-editor';
import { CategoryPicker } from './category-picker';
import { WalkthroughClipPanel } from './walkthrough-clip-panel';

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
  /** Sibling structured_procedure docs in the same content pack version.
   *  Populates the "Linked sub-procedure" picker so the author can wire
   *  this step to launch another procedure when the tech taps Run. */
  siblingProcedures?: AdminSiblingProcedure[];
  /** Visible step categories (built-ins + this org's customs). Threaded
   *  in from the editor — used by the per-step category picker in the
   *  kebab menu so individual steps can carry a badge override even
   *  when their parent section has its own (or no) category. */
  categories?: AdminProcedureStepCategory[];
  /** Open the category manager modal — relayed up from the editor. */
  onManageCategories?: () => void;
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
  siblingProcedures,
  categories,
  onManageCategories,
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
  // Tracks the most recent value we shipped upstream for each debounced
  // field. When the parent re-renders with the post-save step (new
  // updatedAt), we compare the incoming server value to this ref:
  //   - if it matches → it's our own echo → leave local state alone
  //   - if it differs AND local has no unsaved edits → accept (3rd-party)
  //   - if it differs AND local has unsaved edits → ignore; next debounce
  //     flush will overwrite the server with the latest.
  // Without these guards, a save round-trip eats every character the
  // user typed during the round-trip ("autosave drops letters" bug).
  const lastSentTitleRef = useRef(step.title);
  const lastSentBlocksRef = useRef<StepBlock[]>(step.blocks ?? []);
  // Live mirror of `blocks` for the parent-sync effect — reading state
  // directly there would either require `blocks` in the deps (infinite
  // loop with setBlocks) or risk a stale closure.
  const localBlocksRef = useRef<StepBlock[]>(step.blocks ?? []);
  useEffect(() => {
    localBlocksRef.current = blocks;
  }, [blocks]);

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
    // Blocks: same race-protection pattern as title. JSON.stringify is
    // fine here — typical step has ~10 small blocks, so this is sub-ms.
    const incomingBlocks = step.blocks ?? [];
    const incomingStr = JSON.stringify(incomingBlocks);
    const lastSentStr = JSON.stringify(lastSentBlocksRef.current);
    const localStr = JSON.stringify(localBlocksRef.current);
    if (incomingStr !== lastSentStr && localStr === lastSentStr) {
      // 3rd-party change & we have no in-flight edits → accept.
      setBlocks(incomingBlocks);
      lastSentBlocksRef.current = incomingBlocks;
    }
    // (else: server echo of our last save, or we have local edits the
    //  server hasn't seen yet — either way, do nothing.)
    setKind(step.kind);
    setSafetyCritical(step.safetyCritical);
  }, [step.id, step.updatedAt]);

  function onTitleChange(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      titleTimer.current = null;
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
      blocksTimer.current = null;
      // Mark "last sent" BEFORE the request so a fast server echo
      // (which races the next user keystroke) is correctly recognized
      // as ours by the parent-sync effect.
      lastSentBlocksRef.current = next;
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
    lastSentBlocksRef.current = next;
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
        titleTimer.current = null;
        const v = title.trim();
        if (v && v !== step.title) {
          lastSentTitleRef.current = v;
          void onPatch({ title: v });
        }
      }
      if (blocksTimer.current) {
        clearTimeout(blocksTimer.current);
        blocksTimer.current = null;
        if (JSON.stringify(blocks) !== JSON.stringify(step.blocks ?? [])) {
          lastSentBlocksRef.current = blocks;
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
          {step.snippetBadge && (
            <span
              className={[
                'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0',
                step.snippetBadge.detached
                  ? 'border border-line-subtle text-ink-tertiary'
                  : 'bg-accent/10 text-accent',
              ].join(' ')}
              title={
                step.snippetBadge.detached
                  ? `Detached from snippet "${step.snippetBadge.title}". Edits stay on this step.`
                  : `From snippet "${step.snippetBadge.title}". Edits to the snippet propagate here.`
              }
            >
              {step.snippetBadge.isPlatform ? (
                <Globe2 className="size-3" />
              ) : (
                <Puzzle className="size-3" />
              )}
              <span className="max-w-[8rem] truncate">
                {step.snippetBadge.title}
              </span>
            </span>
          )}
          {step.category && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white shrink-0"
              style={{ backgroundColor: step.category.color }}
              title={`Category: ${step.category.name}`}
            >
              <span className="max-w-[6rem] truncate">
                {step.category.name}
              </span>
            </span>
          )}
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
              {categories && categories.length > 0 && (
                <CategoryPicker
                  value={step.categoryId}
                  options={categories}
                  onChange={(next) => void onPatch({ categoryId: next })}
                  onManage={onManageCategories}
                  emptyLabel="Inherit"
                  size="sm"
                  ariaLabel="Step category override"
                />
              )}
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
            {step.snippetBadge && (
              <SnippetBanner
                badge={step.snippetBadge}
                onDetach={async () => {
                  // Server flips snippet_detached on any blocks/title edit;
                  // re-send the current blocks (with a no-op trailing space
                  // appended then trimmed by validation? — simpler: send a
                  // blocks copy. Server diffs aren't required; sending the
                  // same array still counts as an edit.)
                  // Actually we send back the resolved (snippet-expanded)
                  // blocks the user is currently seeing. Server's detach
                  // logic copies snippet content if blocks isn't supplied,
                  // but supplying them is explicit + idempotent.
                  await onPatch({ blocks: step.blocks });
                }}
              />
            )}
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder={
                step.snippetBadge && !step.snippetBadge.detached
                  ? `Override snippet title (or leave blank to use "${step.snippetBadge.title}")`
                  : 'Short imperative — e.g., Apply LOTO and verify zero energy'
              }
              className="w-full bg-transparent text-lg font-semibold text-ink-primary outline-none placeholder:text-ink-tertiary/60 focus:placeholder:text-ink-tertiary/40"
              autoFocus={defaultExpanded}
            />

            {/* Linked sub-procedure picker — wires this step to launch another
                procedure when the tech taps Run in the PWA Job Aid. Useful for
                conditional branches like "Replace the belt, if necessary" →
                Belt Replacement procedure. Only renders when there's at least
                one sibling procedure in the same content pack version.
                When a sub is linked, an optional step-subset checklist
                lets the author pin specific steps from the linked doc so
                techs don't have to navigate the whole procedure. */}
            {siblingProcedures && siblingProcedures.length > 0 && (
              <LinkedSubProcedurePicker
                linkedDocId={step.linkedProcedureDocId}
                linkedStepIds={step.linkedProcedureStepIds}
                siblings={siblingProcedures}
                onChangeDoc={(next) =>
                  void onPatch({
                    linkedProcedureDocId: next,
                    // Clear subset when changing the parent link — IDs from
                    // the old doc are no longer valid against the new one.
                    linkedProcedureStepIds: [],
                  })
                }
                onChangeStepIds={(next) =>
                  void onPatch({ linkedProcedureStepIds: next })
                }
              />
            )}

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

            {/* AI-walkthrough clip trim — only renders when the step carries
                a video_clip media entry, so manual-authored procedures don't
                see an empty editor. Lets admins retrim after publish. */}
            <WalkthroughClipPanel step={step} onChanged={onAudioChanged} />

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

// Banner shown at the top of an expanded step's body when the step is
// snippet-backed. Two states:
//   attached (detached=false) — accent-tinted, shows "From snippet: <title>"
//     and a Detach button. The body editors below are still functional;
//     any inline edit flips detach automatically on the server. The Detach
//     button is an explicit affordance for authors who want to start
//     editing without typing a stray character first.
//   detached (detached=true) — quiet line-only treatment. Informational
//     provenance only; the step has drifted from the snippet.
function SnippetBanner({
  badge,
  onDetach,
}: {
  badge: { id: string; title: string; isPlatform: boolean; detached: boolean };
  onDetach: () => void | Promise<void>;
}) {
  if (badge.detached) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-ink-tertiary">
        <Unlink2 className="size-3" />
        Detached from snippet{' '}
        <span className="font-medium text-ink-secondary">
          "{badge.title}"
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
      {badge.isPlatform ? (
        <Globe2 className="size-4 shrink-0 text-accent" />
      ) : (
        <Puzzle className="size-4 shrink-0 text-accent" />
      )}
      <div className="flex-1">
        <p className="text-xs font-medium text-ink-primary">
          From snippet:{' '}
          <span className="font-semibold text-accent">{badge.title}</span>
          {badge.isPlatform && (
            <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider text-accent/70">
              · Global
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-ink-tertiary">
          Edits to the snippet propagate here. Detach to author this step
          independently.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void onDetach()}
        className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:text-accent"
        title="Detach this step from the snippet"
      >
        <Unlink2 className="size-3" />
        Detach
      </button>
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

// Compact picker that ties this step to a sibling structured_procedure.
// When set, the PWA Job Aid renders a "Run sub-procedure: <title>" button
// below the step content; tapping it pushes the linked procedure as a
// nested Job Aid (with breadcrumb + push/pop). Skipping is just tapping
// Next — the link is treated as an optional branch.
//
// Optional step-subset: when a link is set, the author can pin a subset
// of steps from the linked doc to play. Empty subset = whole procedure
// (default). Useful when the parent only references a few steps from a
// longer procedure so techs don't navigate through irrelevant content.
function LinkedSubProcedurePicker({
  linkedDocId,
  linkedStepIds,
  siblings,
  onChangeDoc,
  onChangeStepIds,
}: {
  linkedDocId: string | null;
  linkedStepIds: string[];
  siblings: AdminSiblingProcedure[];
  onChangeDoc: (next: string | null) => void;
  onChangeStepIds: (next: string[]) => void;
}) {
  const linked = linkedDocId
    ? siblings.find((s) => s.id === linkedDocId) ?? null
    : null;
  // Lazy-fetch the linked doc's outline (sections + steps) for the
  // subset checklist. Steps sort by (section orderingHint, step
  // orderingHint) so the picker matches the order the tech sees in the
  // PWA Job Aid — not the random orderingHint-only sort that interleaves
  // across sections. Section headers render above their steps so the
  // author can see which phase each row belongs to.
  type OutlineStep = {
    id: string;
    title: string;
    orderingHint: number;
    sectionId: string | null;
  };
  type OutlineSection = {
    id: string;
    title: string;
    orderingHint: number;
  };
  const [steps, setSteps] = useState<OutlineStep[] | null>(null);
  const [sections, setSections] = useState<OutlineSection[]>([]);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const [subsetOpen, setSubsetOpen] = useState(false);
  // Reset/refetch when the linked doc changes.
  useEffect(() => {
    if (!linkedDocId) {
      setSteps(null);
      setSections([]);
      setSubsetOpen(false);
      return;
    }
    let cancelled = false;
    setLoadingSteps(true);
    void import('@/lib/api').then(
      ({ listProcedureSteps, listProcedureSections }) =>
        Promise.all([
          listProcedureSteps(linkedDocId),
          listProcedureSections(linkedDocId).catch(() => []),
        ])
          .then(([stepRows, sectionRows]) => {
            if (cancelled) return;
            setSteps(
              stepRows.map((r) => ({
                id: r.id,
                title: r.title,
                orderingHint: r.orderingHint,
                sectionId: r.sectionId,
              })),
            );
            setSections(
              sectionRows.map((s) => ({
                id: s.id,
                title: s.title,
                orderingHint: s.orderingHint,
              })),
            );
          })
          .catch(() => {
            if (!cancelled) {
              setSteps([]);
              setSections([]);
            }
          })
          .finally(() => {
            if (!cancelled) setLoadingSteps(false);
          }),
    );
    return () => {
      cancelled = true;
    };
  }, [linkedDocId]);

  // Compute the canonical display order: orphan steps first (no section
  // header), then each section in its orderingHint sequence with its
  // steps inside. Used for both rendering AND when persisting the user's
  // selection so saved IDs are in the same order the tech will play them.
  const orderedGroups: Array<{
    section: OutlineSection | null;
    items: OutlineStep[];
  }> = (() => {
    if (!steps) return [];
    const sortByHint = (a: OutlineStep, b: OutlineStep) =>
      a.orderingHint - b.orderingHint;
    const orphans = steps
      .filter((s) => s.sectionId == null)
      .slice()
      .sort(sortByHint);
    const sectionGroups = [...sections]
      .sort((a, b) => a.orderingHint - b.orderingHint)
      .map((sec) => ({
        section: sec,
        items: steps
          .filter((s) => s.sectionId === sec.id)
          .slice()
          .sort(sortByHint),
      }));
    const groups: Array<{
      section: OutlineSection | null;
      items: OutlineStep[];
    }> = [];
    if (orphans.length > 0) groups.push({ section: null, items: orphans });
    for (const g of sectionGroups) {
      if (g.items.length > 0) groups.push(g);
    }
    return groups;
  })();
  const orderedSteps = orderedGroups.flatMap((g) => g.items);

  const selectedSet = new Set(linkedStepIds);
  function toggle(id: string) {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Persist IDs in the same canonical order the tech sees them so the
    // PWA's Job Aid plays them in section/step order, not the random
    // sequence the author clicked.
    const ordered = orderedSteps.filter((s) => next.has(s.id)).map((s) => s.id);
    onChangeStepIds(ordered);
  }

  return (
    <div
      className={[
        'flex flex-col gap-2 rounded-md border px-3 py-2 text-sm',
        linked
          ? 'border-accent/30 bg-accent/5'
          : 'border-line-subtle bg-surface-inset',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <ListChecks className="size-3.5" />
          Sub-procedure
        </span>
        <select
          value={linkedDocId ?? ''}
          onChange={(e) =>
            onChangeDoc(e.target.value === '' ? null : e.target.value)
          }
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm text-ink-primary"
        >
          <option value="">— None (no Run button) —</option>
          {siblings.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        {linked && (
          <span className="text-xs text-ink-tertiary">
            Tech taps Run to enter{' '}
            <span className="font-semibold">{linked.title}</span>.
          </span>
        )}
      </div>
      {linked && (
        <div className="flex flex-col gap-1 border-t border-line-subtle pt-2">
          <button
            type="button"
            onClick={() => setSubsetOpen((o) => !o)}
            className="self-start text-xs font-medium text-accent hover:underline"
          >
            {subsetOpen ? '▾' : '▸'} Choose specific steps (optional)
            {linkedStepIds.length > 0 && (
              <span className="ml-2 inline-flex items-center rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">
                {linkedStepIds.length} pinned
              </span>
            )}
          </button>
          {subsetOpen && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] text-ink-tertiary">
                Empty selection = play the full procedure. Picking specific
                steps trims the sub-procedure so the tech only sees these
                rows.
              </p>
              {loadingSteps ? (
                <p className="text-xs text-ink-tertiary">Loading steps…</p>
              ) : orderedGroups.length > 0 ? (
                <div className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded border border-line bg-surface p-1.5">
                  {orderedGroups.map((g) => (
                    <div key={g.section?.id ?? '__orphan__'} className="flex flex-col gap-0.5">
                      {g.section && (
                        // Section header — mirrors the PWA Job Aid's section
                        // pill so the author sees the same grouping they're
                        // pinning steps from. Sticky inside the scrollable
                        // checklist so it stays visible as the author scrolls
                        // through long sections.
                        <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-0.5 border-b border-line-subtle bg-surface/95 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary backdrop-blur">
                          {g.section.title}
                        </div>
                      )}
                      <ul className="flex flex-col gap-0.5">
                        {g.items.map((s, i) => {
                          const checked = selectedSet.has(s.id);
                          return (
                            <li key={s.id}>
                              <label
                                className={[
                                  'flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs',
                                  checked
                                    ? 'bg-accent/10 text-ink-primary'
                                    : 'text-ink-secondary hover:bg-surface-elevated',
                                ].join(' ')}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggle(s.id)}
                                  className="mt-0.5 shrink-0"
                                />
                                {/* Per-section step number — matches the
                                    Job Aid's "Removal: step 3 of 7" cue
                                    so the author picks the right rows. */}
                                <span className="font-mono text-[10px] tabular-nums text-ink-tertiary">
                                  {String(i + 1).padStart(2, '0')}
                                </span>
                                <span className="min-w-0 flex-1 truncate">
                                  {s.title || (
                                    <span className="italic text-ink-tertiary">
                                      Untitled step
                                    </span>
                                  )}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-ink-tertiary">
                  The linked procedure has no steps yet.
                </p>
              )}
              {linkedStepIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChangeStepIds([])}
                  className="self-start text-[11px] text-ink-tertiary hover:text-signal-fault hover:underline"
                >
                  Clear selection (play full procedure)
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
