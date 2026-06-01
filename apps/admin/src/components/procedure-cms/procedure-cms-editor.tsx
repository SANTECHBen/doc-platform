'use client';

// ProcedureCmsEditor — the inline, page-level authoring surface for a
// structured_procedure document. Replaces the old drawer-based steps
// tab. Goals, in priority order:
//
//   1. Direct manipulation. Every step is editable in place; no drawers,
//      no modals. Type a title, drag a step, attach voiceover — all
//      visible together.
//   2. Auto-save. Edits flush on a per-field debounce; the user never
//      thinks about a save button.
//   3. Production-ready feel. Visible save status, drag-to-reorder with
//      drop targets, sensible empty states, robust error surfaces.
//
// The component owns:
//   - The step list (server is the source of truth; we mirror locally so
//     drag-reorder feels instant).
//   - The save-status pill at the top.
//   - Drag-and-drop reorder with optimistic UI + server reconcile.
//   - Inline "Add step" affordance.
//   - "Run on PWA" deeplink (for previewing the runner end-to-end).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  Puzzle,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  createProcedureSection,
  createProcedureStep,
  deleteProcedureSection,
  deleteProcedureStep,
  generateProcedureStepAudio,
  listProcedureStepCategories,
  listSiblingProcedures,
  reorderProcedureSteps,
  updateProcedureSection,
  updateProcedureStep,
  updateAdminDocument,
  uploadAdminFile,
  type AdminDocumentDetail,
  type AdminProcedureDocMetadata,
  type AdminProcedureSection,
  type AdminProcedureStep,
  type AdminProcedureStepCategory,
  type AdminSiblingProcedure,
  type AdminSnippet,
  type CreateProcedureStepInput,
  type UpdateProcedureStepInput,
} from '@/lib/api';
import { SnippetPickerModal } from './snippet-picker-modal';
import { CategoryManagerModal } from './category-manager-modal';
import { CategoryPicker } from './category-picker';
import {
  Clock,
  Film,
  Info,
  Link2,
  Trash2,
  Upload as UploadIcon,
  Wrench,
  X as XIcon,
} from 'lucide-react';
import { parseVideoEmbed } from '@platform/shared';
import { useToast } from '@/components/toast';
import { ErrorBanner } from '@/components/form';
import { StepCard } from './step-card';
import { StepByStepBody } from './step-by-step-body';
import { LayoutList, Rows3 } from 'lucide-react';

interface Props {
  doc: AdminDocumentDetail;
  steps: AdminProcedureStep[];
  /** Optional grouping above steps. Sections render as headers; their
   *  steps re-number from 1. Orphan steps (sectionId === null) render
   *  flat above the first section. */
  sections: AdminProcedureSection[];
  /** Refresh the page-level state after authoritative shape changes
   *  (delete, reorder, add). Field edits don't refetch — we trust the
   *  PATCH response. */
  onChanged: () => Promise<void> | void;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving'; pending: number }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

export function ProcedureCmsEditor({ doc, steps, sections, onChanged }: Props) {
  // Local mirror of the steps so drag-reorder is instant. Server reconcile
  // happens on drop completion; we re-fetch via onChanged() afterwards.
  const [localSteps, setLocalSteps] = useState<AdminProcedureStep[]>(steps);
  const [localSections, setLocalSections] = useState<AdminProcedureSection[]>(sections);
  const [pageError, setPageError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [bulkBusy, setBulkBusy] = useState(false);

  // Drag state — which step is being dragged, and which one would receive
  // the drop right now. Drag is scoped to a single section: cross-section
  // moves use the per-step "Move to section" dropdown instead.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Snippet picker state. When non-null, the modal is open targeting the
  // given section (null = orphan-tier). Selecting a snippet creates a new
  // step in that section backed by the snippet.
  const [snippetPickerSectionId, setSnippetPickerSectionId] = useState<
    string | null | undefined
  >(undefined);
  // The most recently-added step ID. Step cards consult this on mount to
  // decide whether to default-expand: a fresh card should be open so the
  // author can type immediately, while existing cards stay collapsed so
  // the procedure list stays scannable.
  const [freshStepId, setFreshStepId] = useState<string | null>(null);
  // Sibling procedures (same content pack version) — populates the
  // "Linked sub-procedure" picker on each step card. Single fetch at the
  // editor level so we don't N+1 across step cards.
  const [siblingProcedures, setSiblingProcedures] = useState<
    AdminSiblingProcedure[]
  >([]);
  useEffect(() => {
    (async () => {
      try {
        setSiblingProcedures(await listSiblingProcedures(doc.id));
      } catch {
        // Non-fatal — picker just shows "no siblings" when empty.
      }
    })();
  }, [doc.id]);

  // Step categories — built-ins + the doc's owner org's customs. Fetched
  // once at the editor level and threaded through every CategoryPicker
  // so we don't N+1 across sections + steps.
  const [categories, setCategories] = useState<AdminProcedureStepCategory[]>([]);
  useEffect(() => {
    (async () => {
      try {
        setCategories(await listProcedureStepCategories(doc.ownerOrganizationId));
      } catch {
        // Non-fatal — pickers degrade to "No categories yet" with the
        // Manage… link to create some.
      }
    })();
  }, [doc.ownerOrganizationId]);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);

  // View mode — List (default, every step as a card in a vertical list)
  // or Step (single-step focus with a sidebar rail). Same data, same
  // handlers, different layout. Preference persists across procedures
  // (per-browser) so an author who likes Step view doesn't re-pick on
  // every doc.
  const [viewMode, setViewMode] = useState<'list' | 'step'>(() => {
    if (typeof window === 'undefined') return 'list';
    // URL wins when present (share-link / refresh). Otherwise fall back
    // to the localStorage preference.
    try {
      const url = new URL(window.location.href);
      const v = url.searchParams.get('view');
      if (v === 'step' || v === 'list') return v;
      const stored = window.localStorage.getItem('eh:proc-view-mode');
      if (stored === 'step' || stored === 'list') return stored;
    } catch {
      // ignore parse / storage errors
    }
    return 'list';
  });
  // Currently-focused step in Step view. Stored in URL for refresh /
  // share-link continuity. On mount we read it; later changes are pushed
  // via history.replaceState so the back button doesn't trap inside step
  // view.
  const [currentStepId, setCurrentStepIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('stepId');
    } catch {
      return null;
    }
  });
  function setCurrentStepId(next: string | null) {
    setCurrentStepIdState(next);
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set('stepId', next);
      else url.searchParams.delete('stepId');
      window.history.replaceState({}, '', url.toString());
    } catch {
      // ignore — URL update is best-effort
    }
  }
  function changeViewMode(next: 'list' | 'step') {
    setViewMode(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('eh:proc-view-mode', next);
      const url = new URL(window.location.href);
      if (next === 'step') url.searchParams.set('view', 'step');
      else url.searchParams.delete('view');
      window.history.replaceState({}, '', url.toString());
    } catch {
      // ignore
    }
  }

  const toast = useToast();

  // Sync local mirrors when props change (e.g. after onChanged() refresh).
  useEffect(() => {
    setLocalSteps(steps);
  }, [steps]);
  useEffect(() => {
    setLocalSections(sections);
  }, [sections]);

  // Keep currentStepId valid: if it points at a step that's been deleted
  // (or never existed), default to the first step in display order. Run
  // whenever the step list changes or when we enter step view.
  useEffect(() => {
    if (viewMode !== 'step') return;
    if (localSteps.length === 0) {
      if (currentStepId !== null) setCurrentStepId(null);
      return;
    }
    if (currentStepId && localSteps.some((s) => s.id === currentStepId)) return;
    // Pick the first step in canonical display order.
    const sortedSections = [...localSections].sort(
      (a, b) => a.orderingHint - b.orderingHint,
    );
    const orphans = localSteps
      .filter((s) => s.sectionId == null)
      .sort((a, b) => a.orderingHint - b.orderingHint);
    const inSections = sortedSections.flatMap((sec) =>
      localSteps
        .filter((s) => s.sectionId === sec.id)
        .sort((a, b) => a.orderingHint - b.orderingHint),
    );
    const ordered = [...orphans, ...inSections];
    const first = ordered[0] ?? localSteps[0];
    if (first) setCurrentStepId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, localSteps, localSections]);

  // Group steps by sectionId for display. Orphans (sectionId === null) get
  // the synthetic group at the top. Each explicit section gets its own group
  // in section.orderingHint order; within a group, steps are sorted by their
  // own orderingHint. This is the order the runner / viewer use too.
  const groups = useMemo(() => {
    const byId = new Map<string, AdminProcedureStep[]>();
    const orphans: AdminProcedureStep[] = [];
    for (const s of localSteps) {
      if (s.sectionId === null) {
        orphans.push(s);
        continue;
      }
      const arr = byId.get(s.sectionId) ?? [];
      arr.push(s);
      byId.set(s.sectionId, arr);
    }
    const sortByHint = (a: AdminProcedureStep, b: AdminProcedureStep) =>
      a.orderingHint - b.orderingHint;
    orphans.sort(sortByHint);
    const sectionGroups = [...localSections]
      .sort((a, b) => a.orderingHint - b.orderingHint)
      .map((sec) => ({
        section: sec,
        steps: (byId.get(sec.id) ?? []).sort(sortByHint),
      }));
    return { orphans, sectionGroups };
  }, [localSteps, localSections]);

  // ------------------------------------------------------------------
  // Save tracking
  // ------------------------------------------------------------------
  const pendingRef = useRef(0);
  function beginSave() {
    pendingRef.current += 1;
    setStatus({ kind: 'saving', pending: pendingRef.current });
  }
  function endSave(ok: boolean, message?: string) {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (!ok) {
      setStatus({ kind: 'error', message: message ?? 'Save failed' });
      return;
    }
    if (pendingRef.current === 0) {
      setStatus({ kind: 'saved', at: Date.now() });
      // Linger long enough for an author who's actively typing to glance
      // up and see the confirmation. Decays to "All changes saved" idle
      // state after this.
      setTimeout(
        () =>
          setStatus((s) =>
            s.kind === 'saved' && Date.now() - s.at >= 2700 ? { kind: 'idle' } : s,
          ),
        3000,
      );
    } else {
      setStatus({ kind: 'saving', pending: pendingRef.current });
    }
  }

  // ------------------------------------------------------------------
  // Per-step patch handler — used by every inline-editable field.
  // Returns the updated step so child components can refresh.
  // ------------------------------------------------------------------
  async function patchStep(
    stepId: string,
    patch: UpdateProcedureStepInput,
  ): Promise<AdminProcedureStep | null> {
    beginSave();
    try {
      const updated = await updateProcedureStep(stepId, patch);
      setLocalSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, ...updated } : s)),
      );
      endSave(true);
      return updated;
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Add / delete
  // ------------------------------------------------------------------
  async function addStep(sectionId: string | null = null) {
    const input: CreateProcedureStepInput = {
      kind: 'instruction',
      title: '',
      bodyMarkdown: null,
      safetyCritical: false,
      sectionId,
    };
    beginSave();
    try {
      const created = await createProcedureStep(doc.id, input);
      // Optimistic insert at the end — match server's append-with-stride.
      setLocalSteps((prev) => [...prev, created]);
      // Tell the card to default-expand on its first render. defaultExpanded
      // only consults the initial state, so a single render with this ID
      // matching is enough — no need to clear it back out.
      setFreshStepId(created.id);
      // Step view: focus the freshly-added step so the author can type
      // immediately. Harmless in list view (currentStepId is unused
      // there; just remembered for the next mode toggle).
      setCurrentStepId(created.id);
      endSave(true);
      // Smooth-scroll to the new card so the focus is obvious (list view).
      setTimeout(() => {
        document.getElementById(`cms-step-${created.id}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 50);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
    }
  }

  // Create a new step backed by a reusable snippet. Server resolves the
  // snippet's blocks/title at read time (always-latest) until the author
  // edits the step inline (detach-on-edit).
  //
  // Snippets are inserted at the TOP of the target section (or top of
  // the whole procedure for orphan inserts). The dominant snippet use
  // case is safety boilerplate — LOTO, PPE briefing — which logically
  // belongs as Step 1, not whatever step happens to come last. The
  // author can drag-reorder afterward if a different position is
  // wanted.
  async function addStepFromSnippet(
    snippet: AdminSnippet,
    sectionId: string | null = null,
  ) {
    // Compute an orderingHint smaller than every existing step in the
    // target scope so the new step lands first. The reorder endpoint
    // re-stamps at 100-stride; we just need ANY value below the current
    // minimum, and 100 below leaves room for further inserts above.
    const scopeSteps = localSteps.filter((s) =>
      sectionId === null ? s.sectionId === null : s.sectionId === sectionId,
    );
    const minHint = scopeSteps.length
      ? Math.min(...scopeSteps.map((s) => s.orderingHint))
      : 100;
    // Floor at 1 — orderingHint is int; we want strictly > 0 so the
    // server's "max + 100" append on the NEXT addStep still produces a
    // sensible ordering.
    const orderingHint = Math.max(1, minHint - 100);

    const input: CreateProcedureStepInput = {
      kind: snippet.kind,
      // Leave title blank so the snippet's own title flows through on
      // read. Authors can override per-step by typing in the card.
      title: '',
      bodyMarkdown: null,
      safetyCritical: snippet.kind === 'safety_check',
      sectionId,
      snippetId: snippet.id,
      orderingHint,
    };
    beginSave();
    try {
      const created = await createProcedureStep(doc.id, input);
      // Insert at the front of local state (matching the server's
      // orderingHint) so the UI doesn't flash the new step at the
      // bottom before the next refetch.
      setLocalSteps((prev) => [created, ...prev]);
      // Don't default-expand a snippet-backed step — its content is
      // read-only until detached, and the collapsed row already shows the
      // resolved title.
      // Step view: still focus the inserted snippet so the author lands
      // on it. They can detach + edit from there.
      setCurrentStepId(created.id);
      endSave(true);
      setTimeout(() => {
        document.getElementById(`cms-step-${created.id}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 50);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------------
  // Section CRUD. Sections are optional grouping above steps; deleting a
  // section orphans (doesn't delete) its child steps so authors don't
  // lose work mid-reorganization.
  // ------------------------------------------------------------------
  async function addSection() {
    const title = prompt('Section name (e.g. "Removal", "Replacement"):')?.trim();
    if (!title) return;
    beginSave();
    try {
      const created = await createProcedureSection(doc.id, { title });
      setLocalSections((prev) => [...prev, created]);
      endSave(true);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
      toast.error(
        'Could not add section',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  async function renameSection(sectionId: string, nextTitle: string) {
    const trimmed = nextTitle.trim();
    if (!trimmed) return;
    beginSave();
    try {
      const updated = await updateProcedureSection(sectionId, { title: trimmed });
      setLocalSections((prev) =>
        prev.map((s) => (s.id === sectionId ? updated : s)),
      );
      endSave(true);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
    }
  }

  async function recategorizeSection(
    sectionId: string,
    categoryId: string | null,
  ) {
    beginSave();
    try {
      const updated = await updateProcedureSection(sectionId, { categoryId });
      setLocalSections((prev) =>
        prev.map((s) => (s.id === sectionId ? updated : s)),
      );
      endSave(true);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
      toast.error(
        'Could not change section category',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  async function removeSection(sectionId: string) {
    const sec = localSections.find((s) => s.id === sectionId);
    if (!sec) return;
    const stepCount = localSteps.filter((s) => s.sectionId === sectionId).length;
    const msg =
      stepCount === 0
        ? `Delete section "${sec.title}"?`
        : `Delete section "${sec.title}"? Its ${stepCount} step${
            stepCount === 1 ? '' : 's'
          } will be moved to the ungrouped area at the top — they aren't deleted.`;
    if (!confirm(msg)) return;
    beginSave();
    try {
      await deleteProcedureSection(sectionId);
      setLocalSections((prev) => prev.filter((s) => s.id !== sectionId));
      // Children locally become orphans (server already set their sectionId = null
      // via FK ON DELETE SET NULL, but our local mirror needs the same flip).
      setLocalSteps((prev) =>
        prev.map((s) => (s.sectionId === sectionId ? { ...s, sectionId: null } : s)),
      );
      endSave(true);
    } catch (e) {
      endSave(false, e instanceof Error ? e.message : String(e));
      toast.error(
        'Could not delete section',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  async function moveStepToSection(stepId: string, sectionId: string | null) {
    // Patch the step's sectionId. Server rejects mismatched-doc section IDs.
    const updated = await patchStep(stepId, { sectionId });
    if (updated) {
      setLocalSteps((prev) =>
        prev.map((s) => (s.id === stepId ? { ...s, sectionId } : s)),
      );
    }
  }

  async function deleteStep(stepId: string) {
    const step = localSteps.find((s) => s.id === stepId);
    if (!step) return;
    if (!confirm(`Delete step "${step.title || `#${stepId.slice(0, 6)}`}"? This can't be undone.`)) {
      return;
    }
    beginSave();
    try {
      await deleteProcedureStep(stepId);
      setLocalSteps((prev) => prev.filter((s) => s.id !== stepId));
      endSave(true);
    } catch (e) {
      // Most common 409: existing run completions reference this step.
      // We surface that with a useful message rather than swallow.
      endSave(false, e instanceof Error ? e.message : String(e));
      toast.error(
        'Could not delete step',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // ------------------------------------------------------------------
  // Drag-and-drop reorder. HTML5 native — keeps the dependency surface
  // small. We track the dragged id + the would-be drop target; on drop
  // we splice locally for instant feedback, then PATCH the server.
  // ------------------------------------------------------------------
  function onDragStart(id: string) {
    return (e: React.DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      // Hide the default browser drag image — our card visual reads cleaner
      // with the natural translate from the cursor.
    };
  }
  function onDragOver(id: string) {
    return (e: React.DragEvent) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTargetId !== id) setDropTargetId(id);
    };
  }
  function onDrop(targetId: string) {
    return async (e: React.DragEvent) => {
      e.preventDefault();
      const sourceId = dragId ?? e.dataTransfer.getData('text/plain');
      setDragId(null);
      setDropTargetId(null);
      if (!sourceId || sourceId === targetId) return;
      const src = localSteps.findIndex((s) => s.id === sourceId);
      const tgt = localSteps.findIndex((s) => s.id === targetId);
      if (src < 0 || tgt < 0) return;
      const next = [...localSteps];
      const [moved] = next.splice(src, 1);
      if (!moved) return;
      next.splice(tgt, 0, moved);
      setLocalSteps(next);
      beginSave();
      try {
        await reorderProcedureSteps(
          doc.id,
          next.map((s) => s.id),
        );
        endSave(true);
        await onChanged();
      } catch (err) {
        endSave(false, err instanceof Error ? err.message : String(err));
        toast.error(
          'Reorder failed',
          err instanceof Error ? err.message : String(err),
        );
        // Roll back on failure.
        setLocalSteps(localSteps);
      }
    };
  }
  function onDragEnd() {
    setDragId(null);
    setDropTargetId(null);
  }

  // ------------------------------------------------------------------
  // Bulk: generate audio for all steps that don't have it. Useful right
  // after promoting an AI answer — one click and the whole procedure
  // has voice.
  // ------------------------------------------------------------------
  async function generateAllAudio() {
    const targets = localSteps.filter((s) => !s.audioUrl && s.title.trim());
    if (targets.length === 0) {
      toast.info('Every step already has voiceover', 'Or no steps have a title yet.');
      return;
    }
    if (
      !confirm(
        `Generate AI voiceover for ${targets.length} step${targets.length === 1 ? '' : 's'}? This will use OpenAI TTS — about ${Math.ceil(targets.length * 2.5)}¢ total.`,
      )
    ) {
      return;
    }
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    for (const s of targets) {
      try {
        beginSave();
        const r = await generateProcedureStepAudio(s.id);
        setLocalSteps((prev) =>
          prev.map((p) =>
            p.id === s.id
              ? {
                  ...p,
                  audioStorageKey: 'set',
                  audioContentType: r.audioContentType,
                  audioSizeBytes: r.audioSizeBytes,
                  audioSource: r.audioSource,
                  audioUrl: r.audioUrl,
                  audioDurationMs: null,
                }
              : p,
          ),
        );
        endSave(true);
        ok += 1;
      } catch (e) {
        endSave(false, e instanceof Error ? e.message : String(e));
        fail += 1;
      }
    }
    setBulkBusy(false);
    if (fail === 0) {
      toast.success(`Generated voiceover for ${ok} steps`);
    } else if (ok === 0) {
      toast.error('All audio generations failed');
    } else {
      toast.success(`Generated ${ok} steps`, `${fail} failed — try again on those.`);
    }
  }

  const empty = localSteps.length === 0;
  const hasAudioCount = useMemo(
    () => localSteps.filter((s) => s.audioUrl).length,
    [localSteps],
  );

  return (
    <div className="space-y-4">
      <ErrorBanner error={pageError} />

      {/* Sticky status / action bar */}
      <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-line-subtle bg-surface-raised/80 px-4 py-2.5 backdrop-blur-md">
        <SaveStatusPill status={status} />
        <span className="text-xs text-ink-tertiary">
          {localSteps.length} step{localSteps.length === 1 ? '' : 's'}
          {' · '}
          {hasAudioCount} with voiceover
        </span>
        {/* View mode toggle — List (the existing card-list view) vs.
            Step (one-step focus with a left rail). Persists per browser. */}
        <ViewModeToggle value={viewMode} onChange={changeViewMode} />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={generateAllAudio}
            disabled={bulkBusy || empty}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
            title="Generate AI voiceover for every step that doesn't have one yet"
          >
            {bulkBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Wand2 className="size-3.5" />
            )}
            Generate all audio
          </button>
          {doc.kind === 'structured_procedure' && (
            <>
              <a
                href={`/procedures/${encodeURIComponent(doc.id)}/edit`}
                className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs font-medium text-accent transition hover:border-accent hover:bg-accent/10"
                title="Open the distraction-free full-page authoring view"
              >
                <ExternalLink className="size-3.5" />
                Full-page editor
              </a>
              <a
                href={`/documents/${encodeURIComponent(doc.id)}?tab=overview`}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5"
              >
                Overview
              </a>
            </>
          )}
        </div>
      </div>

      {/* Intro video — procedure-level. Renders on the PWA's Step 0
          landing page in Job Aid view and at the top of the scroll
          view. Optional; only matters for training-style procedures.
          Shown in List view only; Step view focuses on per-step
          authoring — procedure-level metadata stays accessible by
          toggling back to List. */}
      {doc.kind === 'structured_procedure' && viewMode === 'list' && (
        <>
          <HeroVideoSection doc={doc} onChanged={onChanged} />
          <OverviewSection doc={doc} onChanged={onChanged} />
        </>
      )}

      {viewMode === 'step' ? (
        // Sticky, viewport-anchored wrapper so the step view always fills
        // the visible area below the editor's chrome. Without this, the
        // step view was a fixed-height block that scrolled with the page —
        // and once the page hit its bottom, users couldn't reach later
        // steps in the rail because the rail's own overflow wasn't getting
        // a chance to engage (it can only scroll when its parent has a
        // bounded height). dvh handles mobile address-bar shrink/grow.
        //
        // Offsets: the page header is sticky at top:0 (~4rem tall in this
        // app); we leave 1rem of breathing room and another ~0.5rem of
        // padding below the bottom edge.
        <div className="sticky top-[4.5rem] z-10 h-[calc(100dvh-6rem)] min-h-0">
          <StepByStepBody
            steps={localSteps}
            sections={localSections}
            currentStepId={currentStepId}
            setCurrentStepId={setCurrentStepId}
            onPatch={patchStep}
            onDeleteStep={deleteStep}
            onAudioChanged={(stepId, next) =>
              setLocalSteps((prev) =>
                prev.map((p) => (p.id === stepId ? next : p)),
              )
            }
            onMoveStepToSection={moveStepToSection}
            onAddStep={addStep}
            onInsertSnippet={(sectionId) => setSnippetPickerSectionId(sectionId)}
            onAddSection={addSection}
            onRenameSection={renameSection}
            onDeleteSection={removeSection}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            dragId={dragId}
            dropTargetId={dropTargetId}
            siblingProcedures={siblingProcedures}
            categories={categories}
            onManageCategories={() => setCategoryManagerOpen(true)}
            bulkBusy={bulkBusy}
            freshStepId={freshStepId}
          />
        </div>
      ) : empty && localSections.length === 0 ? (
        <EmptyState onAdd={() => addStep(null)} />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Orphan steps — anything not in a section renders flat at the top.
              When a procedure has no sections at all (most new authoring),
              this is the whole list and the section UI stays out of the way. */}
          {groups.orphans.length > 0 && (
            <ol className="flex flex-col gap-2" onDragEnd={onDragEnd}>
              {groups.orphans.map((s, i) => (
                <div key={s.id} id={`cms-step-${s.id}`}>
                  <StepCard
                    step={s}
                    index={i}
                    totalSteps={groups.orphans.length}
                    onPatch={(patch) => patchStep(s.id, patch)}
                    onDelete={() => deleteStep(s.id)}
                    onAudioChanged={(next) =>
                      setLocalSteps((prev) =>
                        prev.map((p) => (p.id === s.id ? next : p)),
                      )
                    }
                    draggable={!bulkBusy}
                    onDragStart={onDragStart(s.id)}
                    onDragOver={onDragOver(s.id)}
                    onDrop={onDrop(s.id)}
                    onDragEnd={onDragEnd}
                    isDragging={dragId === s.id}
                    isDropTarget={dropTargetId === s.id && dragId !== s.id}
                    sections={localSections}
                    onMoveToSection={(target) =>
                      moveStepToSection(s.id, target)
                    }
                    defaultExpanded={freshStepId === s.id}
                    siblingProcedures={siblingProcedures}
                    categories={categories}
                    onManageCategories={() => setCategoryManagerOpen(true)}
                  />
                </div>
              ))}
            </ol>
          )}

          {/* Each section renders its own grouped <ol>. Step numbers restart
              from 1 within each section — that's the whole point of sectioning
              a Removal & Replacement procedure. */}
          {groups.sectionGroups.map((g) => (
            <SectionGroup
              key={g.section.id}
              section={g.section}
              steps={g.steps}
              allSections={localSections}
              bulkBusy={bulkBusy}
              dragId={dragId}
              dropTargetId={dropTargetId}
              onAddStep={() => addStep(g.section.id)}
              onInsertSnippet={() => setSnippetPickerSectionId(g.section.id)}
              onRenameSection={(t) => renameSection(g.section.id, t)}
              onDeleteSection={() => removeSection(g.section.id)}
              onRecategorizeSection={(cid) =>
                recategorizeSection(g.section.id, cid)
              }
              onPatchStep={patchStep}
              onDeleteStep={deleteStep}
              onMoveStep={moveStepToSection}
              onAudioChanged={(stepId, next) =>
                setLocalSteps((prev) =>
                  prev.map((p) => (p.id === stepId ? next : p)),
                )
              }
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
              freshStepId={freshStepId}
              siblingProcedures={siblingProcedures}
              categories={categories}
              onManageCategories={() => setCategoryManagerOpen(true)}
            />
          ))}
        </div>
      )}

      {/* List-view-only trailing add affordances. Step view's rail has
          equivalent "+ Add step" / "+ Add section" buttons inline, so
          rendering these again would be duplicate UI. */}
      {viewMode === 'list' && (
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          <button
            type="button"
            onClick={() => addStep(null)}
            className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-4 text-sm font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
          >
            <Plus className="size-4 transition group-hover:rotate-90" />
            Add step
          </button>
          <button
            type="button"
            onClick={() => setSnippetPickerSectionId(null)}
            className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-4 text-sm font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
            title="Insert a reusable step (Lockout-Tagout, Safety Briefing, etc.). Edits to the snippet propagate to every step that uses it."
          >
            <Puzzle className="size-4" />
            Insert snippet
          </button>
          <button
            type="button"
            onClick={addSection}
            className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-4 text-sm font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
            title='Add a named section (e.g. "Removal", "Replacement"). Step numbers restart inside each section.'
          >
            <Plus className="size-4 transition group-hover:rotate-90" />
            Add section
          </button>
        </div>
      )}

      <SnippetPickerModal
        open={snippetPickerSectionId !== undefined}
        onClose={() => setSnippetPickerSectionId(undefined)}
        onPick={(s) => {
          const targetSection = snippetPickerSectionId ?? null;
          void addStepFromSnippet(s, targetSection);
        }}
        ownerOrganizationId={doc.ownerOrganizationId}
      />

      <CategoryManagerModal
        open={categoryManagerOpen}
        onClose={() => setCategoryManagerOpen(false)}
        organizationId={doc.ownerOrganizationId}
        onChanged={(next) => setCategories(next)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionGroup — header + step list for one named section. Self-contained so
// the editor's render block stays scannable.
// ---------------------------------------------------------------------------
function SectionGroup({
  section,
  steps,
  allSections,
  bulkBusy,
  dragId,
  dropTargetId,
  onAddStep,
  onInsertSnippet,
  onRenameSection,
  onDeleteSection,
  onRecategorizeSection,
  onPatchStep,
  onDeleteStep,
  onMoveStep,
  onAudioChanged,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  freshStepId,
  siblingProcedures,
  categories,
  onManageCategories,
}: {
  section: AdminProcedureSection;
  steps: AdminProcedureStep[];
  allSections: AdminProcedureSection[];
  bulkBusy: boolean;
  dragId: string | null;
  dropTargetId: string | null;
  onAddStep: () => void;
  onInsertSnippet: () => void;
  onRenameSection: (title: string) => void;
  onDeleteSection: () => void;
  onRecategorizeSection: (categoryId: string | null) => void;
  onPatchStep: (
    stepId: string,
    patch: UpdateProcedureStepInput,
  ) => Promise<AdminProcedureStep | null>;
  onDeleteStep: (stepId: string) => Promise<void>;
  onMoveStep: (stepId: string, sectionId: string | null) => Promise<void>;
  onAudioChanged: (stepId: string, next: AdminProcedureStep) => void;
  onDragStart: (id: string) => (e: React.DragEvent) => void;
  onDragOver: (id: string) => (e: React.DragEvent) => void;
  onDrop: (id: string) => (e: React.DragEvent) => Promise<void>;
  onDragEnd: () => void;
  /** ID of the most recently-added step. The matching card mounts expanded
   *  so the author can type immediately. */
  freshStepId: string | null;
  /** Sibling structured_procedure docs in the same content pack version,
   *  surfaced to each step card's "Linked sub-procedure" picker. */
  siblingProcedures: AdminSiblingProcedure[];
  /** Visible categories (built-ins + this org's). Pre-fetched at the
   *  editor level and threaded down to avoid N+1 across sections. */
  categories: AdminProcedureStepCategory[];
  /** Opens the category manager modal — wired through from the editor. */
  onManageCategories: () => void;
}) {
  // Local title mirror with debounced PATCH — same pattern as step titles,
  // including the lastSentTitleRef guard. Without it, the parent-sync
  // effect clobbers in-flight keystrokes whenever a save round-trip lands
  // mid-typing (the "autosave drops letters" bug).
  const [title, setTitle] = useState(section.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentTitleRef = useRef(section.title);
  // Live mirror of `title` + `section.title` for the unmount-flush effect.
  // Reading state inside an effect with [] deps yields the mount-time
  // value; refs sidestep that without making the cleanup churn.
  const titleRef = useRef(title);
  const sectionTitleRef = useRef(section.title);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    sectionTitleRef.current = section.title;
    if (section.title !== lastSentTitleRef.current) {
      // Third-party change (or a fresh section.id swapping in) — accept.
      // If the incoming value equals what we last sent, it's our own
      // echo and we leave the local state alone so any keystrokes that
      // happened during the round-trip stay put.
      setTitle(section.title);
      lastSentTitleRef.current = section.title;
    }
  }, [section.title]);
  function onTitleInput(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      titleTimer.current = null;
      const v = next.trim();
      if (v && v !== section.title) {
        lastSentTitleRef.current = v;
        onRenameSection(v);
      }
    }, 600);
  }
  // Flush on unmount so a quick page-navigation doesn't drop the user's
  // last keystrokes (the debounced save hasn't fired yet).
  useEffect(() => {
    return () => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current);
        titleTimer.current = null;
        const v = titleRef.current.trim();
        if (v && v !== sectionTitleRef.current) {
          lastSentTitleRef.current = v;
          onRenameSection(v);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface-raised p-3">
      {/* Sticky section header — as the author scrolls into a long section,
          its title pins to the top of the scroll container so the answer
          to "where am I?" is always one glance away. backdrop-blur + a
          subtle bg keeps the underlying step rows legible behind it. */}
      <header
        className="sticky top-0 z-10 -mx-3 -mt-3 flex items-center gap-2 rounded-t-lg border-b border-line-subtle bg-surface-raised/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-surface-raised/80"
      >
        <span className="select-none text-xs font-semibold uppercase tracking-wider text-ink-tertiary">
          Section
        </span>
        <input
          value={title}
          onChange={(e) => onTitleInput(e.target.value)}
          className="flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-semibold text-ink-primary outline-none transition focus:border-accent focus:bg-surface"
          placeholder="Section name"
        />
        <CategoryPicker
          value={section.categoryId}
          options={categories}
          onChange={onRecategorizeSection}
          onManage={onManageCategories}
          emptyLabel="No category"
          size="sm"
          ariaLabel={`Section category for ${section.title}`}
        />
        <span className="select-none text-xs text-ink-tertiary">
          {steps.length} step{steps.length === 1 ? '' : 's'} · numbering restarts at 1
        </span>
        <button
          type="button"
          onClick={onDeleteSection}
          className="rounded-md p-1 text-ink-tertiary transition hover:bg-signal-fault/10 hover:text-signal-fault"
          title="Delete section (steps survive as orphans)"
        >
          <Trash2 className="size-4" />
        </button>
      </header>

      {steps.length === 0 ? (
        <p className="rounded-md border border-dashed border-line bg-surface px-4 py-3 text-center text-sm text-ink-tertiary">
          Empty section. Click "Add step in this section" below to author the first one.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" onDragEnd={onDragEnd}>
          {steps.map((s, i) => (
            <div key={s.id} id={`cms-step-${s.id}`}>
              <StepCard
                step={s}
                index={i}
                totalSteps={steps.length}
                onPatch={(patch) => onPatchStep(s.id, patch)}
                onDelete={() => onDeleteStep(s.id)}
                onAudioChanged={(next) => onAudioChanged(s.id, next)}
                draggable={!bulkBusy}
                onDragStart={onDragStart(s.id)}
                onDragOver={onDragOver(s.id)}
                onDrop={onDrop(s.id)}
                onDragEnd={onDragEnd}
                isDragging={dragId === s.id}
                isDropTarget={dropTargetId === s.id && dragId !== s.id}
                sections={allSections}
                onMoveToSection={(target) => onMoveStep(s.id, target)}
                defaultExpanded={freshStepId === s.id}
                siblingProcedures={siblingProcedures}
                categories={categories}
                onManageCategories={onManageCategories}
              />
            </div>
          ))}
        </ol>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onAddStep}
          className="group flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-3 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
        >
          <Plus className="size-3.5 transition group-hover:rotate-90" />
          Add step
        </button>
        <button
          type="button"
          onClick={onInsertSnippet}
          className="flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-surface px-4 py-3 text-xs font-medium text-ink-secondary transition hover:border-accent/40 hover:bg-accent/5 hover:text-accent"
          title="Insert a reusable snippet"
        >
          <Puzzle className="size-3.5" />
          Insert snippet
        </button>
      </div>
    </section>
  );
}

function SaveStatusPill({ status }: { status: SaveStatus }) {
  // Larger, higher-contrast surfaces — auto-save is invisible if the
  // status pill is too quiet to notice.
  if (status.kind === 'saving') {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-accent px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm">
        <Loader2 className="size-4 animate-spin" />
        Saving…
      </span>
    );
  }
  if (status.kind === 'saved') {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-signal-ok px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm"
        // Brief flash so the author actually sees the confirmation before
        // it decays back to the steady-state pill.
      >
        <CheckCircle2 className="size-4" />
        Saved
      </span>
    );
  }
  if (status.kind === 'error') {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-signal-fault px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm"
        title={status.message}
      >
        <AlertTriangle className="size-4" />
        Save failed — retry
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm font-medium text-ink-secondary">
      <CheckCircle2 className="size-4 text-signal-ok" />
      All changes saved
    </span>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface-raised px-6 py-16 text-center">
      <Sparkles className="size-7 text-accent/60" />
      <p className="text-base font-semibold text-ink-primary">
        Author your first step
      </p>
      <p className="max-w-md text-sm text-ink-tertiary">
        Each step becomes a card the tech walks through hands-free —
        with custom voiceover, photos, and (optional) measurement evidence.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
      >
        <Plus className="size-4" />
        Add first step
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewModeToggle — pill that switches between List view (default card
// list) and Step view (one-step focus with rail). Persists per-browser.
// Lives in the sticky top bar next to the save-status pill.
// ---------------------------------------------------------------------------
function ViewModeToggle({
  value,
  onChange,
}: {
  value: 'list' | 'step';
  onChange: (next: 'list' | 'step') => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Procedure editor view mode"
      className="inline-flex rounded-md border border-line-subtle bg-surface p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'list'}
        onClick={() => onChange('list')}
        className={[
          'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
          value === 'list'
            ? 'bg-accent text-white shadow-sm'
            : 'text-ink-secondary hover:text-ink-primary',
        ].join(' ')}
        title="List view — all steps as cards"
      >
        <Rows3 className="size-3.5" />
        List
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'step'}
        onClick={() => onChange('step')}
        className={[
          'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition',
          value === 'step'
            ? 'bg-accent text-white shadow-sm'
            : 'text-ink-secondary hover:text-ink-primary',
        ].join(' ')}
        title="Step view — one step at a time with a sidebar rail"
      >
        <LayoutList className="size-3.5" />
        Step
      </button>
    </div>
  );
}

// HeroVideoSection — procedure-level intro-video authoring card. Sits
// above the step list. Optional feature; most procedures won't use it,
// but training-style procedures (LOTO, safety briefings) benefit from
// a single overview video at the top of the walkthrough.
function HeroVideoSection({
  doc,
  onChanged,
}: {
  doc: AdminDocumentDetail;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  // Upload progress 0–100, or null when not actively uploading. The
  // PATCH that follows is fast, so we only show the bar during the
  // multipart POST itself.
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  const hero = doc.procedureMetadata?.heroVideo ?? null;
  const heroEmbed = hero?.url ? parseVideoEmbed(hero.url) : null;

  // Build the metadata object to PATCH. Always send the full shape so
  // we don't accidentally drop tools/safety/verification when patching
  // just the hero.
  function buildMetadata(
    heroPatch: AdminProcedureDocMetadata['heroVideo'] | null,
  ): AdminProcedureDocMetadata {
    const base = doc.procedureMetadata ?? {
      toolsRequired: { common: [], special: [], consumables: [] },
      safety: { enabled: false, notes: null },
      verification: { enabled: false, notes: null },
    };
    return {
      ...base,
      heroVideo: heroPatch,
    };
  }

  async function onPick(file: File) {
    setBusy(true);
    setError(null);
    setUploadPct(0);
    try {
      if (!file.type.startsWith('video/')) {
        throw new Error('Please choose a video file.');
      }
      const uploaded = await uploadAdminFile(file, {
        onProgress: (pct) => setUploadPct(Math.round(pct)),
      });
      // Upload finished; server is now writing metadata. Clear the bar.
      setUploadPct(null);
      const meta = buildMetadata({
        storageKey: uploaded.storageKey,
        mime: uploaded.contentType,
        sizeBytes: uploaded.size,
        caption: hero?.caption ?? null,
      });
      await updateAdminDocument(doc.id, { procedureMetadata: meta });
      await onChanged();
      toast.success('Intro video uploaded.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(`Upload failed: ${message}`);
    } finally {
      setBusy(false);
      setUploadPct(null);
    }
  }

  async function onRemove() {
    if (!hero) return;
    setBusy(true);
    setError(null);
    try {
      const meta = buildMetadata(null);
      await updateAdminDocument(doc.id, { procedureMetadata: meta });
      await onChanged();
      toast.success('Intro video removed.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(`Update failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSetUrl() {
    const trimmed = urlDraft.trim();
    if (!trimmed) return;
    const embed = parseVideoEmbed(trimmed);
    if (!embed) {
      setError('Enter a valid http(s) URL.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // mime is required by the schema but loses meaning for external
      // links — store a provider tag for display purposes.
      const mime =
        embed.kind === 'youtube'
          ? 'video/youtube'
          : embed.kind === 'vimeo'
            ? 'video/vimeo'
            : 'video/external';
      const meta = buildMetadata({
        sourceUrl: trimmed,
        mime,
        caption: hero?.caption ?? null,
      });
      await updateAdminDocument(doc.id, { procedureMetadata: meta });
      await onChanged();
      setUrlDraft('');
      toast.success('Intro video URL saved.');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error(`Update failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  const progressBar =
    uploadPct !== null ? (
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line-subtle">
          <div
            className="h-full bg-accent transition-[width] duration-150 ease-linear"
            style={{ width: `${uploadPct}%` }}
          />
        </div>
        <span className="tabular-nums text-xs text-ink-tertiary">
          {uploadPct}%
        </span>
      </div>
    ) : null;

  return (
    <div className="rounded-lg border border-line-subtle bg-surface-raised p-4">
      <div className="mb-2 flex items-center gap-2">
        <Film className="size-4 text-accent" />
        <h3 className="text-sm font-semibold text-ink-primary">Intro video</h3>
        <span className="text-xs text-ink-tertiary">
          Optional — shows on Step 0 of the Job Aid view
        </span>
      </div>
      {error && (
        <p className="mb-2 text-xs text-signal-fault" role="alert">
          {error}
        </p>
      )}
      {hero ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          {hero.url &&
            (heroEmbed?.kind === 'youtube' || heroEmbed?.kind === 'vimeo' ? (
              <iframe
                src={heroEmbed.embedUrl}
                title="Intro video preview"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="aspect-video w-full max-w-sm rounded border border-line bg-black"
              />
            ) : (
              <video
                src={hero.url}
                controls
                preload="metadata"
                className="aspect-video w-full max-w-sm rounded border border-line bg-black"
              />
            ))}
          <div className="flex flex-1 flex-col gap-2 text-xs text-ink-secondary">
            <div>
              <span className="text-ink-tertiary">Source:</span>{' '}
              {hero.sourceUrl ? (
                <a
                  href={hero.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-accent underline"
                >
                  {hero.sourceUrl}
                </a>
              ) : (
                'Uploaded file'
              )}
            </div>
            <div>
              <span className="text-ink-tertiary">Type:</span> {hero.mime}
            </div>
            {hero.sizeBytes !== undefined && (
              <div>
                <span className="text-ink-tertiary">Size:</span>{' '}
                {(hero.sizeBytes / (1024 * 1024)).toFixed(2)} MB
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <label
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 ${
                  busy ? 'pointer-events-none opacity-50' : ''
                }`}
              >
                <UploadIcon className="size-3.5" />
                {uploadPct !== null
                  ? `Uploading… ${uploadPct}%`
                  : 'Replace with upload'}
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onPick(f);
                    e.target.value = '';
                  }}
                  className="hidden"
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                onClick={onRemove}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-signal-fault transition hover:border-signal-fault/40 hover:bg-signal-fault/5 disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
                Remove
              </button>
            </div>
            {progressBar}
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <input
                type="url"
                placeholder="Replace with URL — YouTube, Vimeo, or .mp4"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                disabled={busy}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void onSetUrl()}
                disabled={busy || !urlDraft.trim()}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
              >
                <Link2 className="size-3.5" />
                Set URL
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label
            className={`inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 ${
              busy ? 'pointer-events-none opacity-50' : ''
            }`}
          >
            <UploadIcon className="size-3.5" />
            {uploadPct !== null
              ? `Uploading… ${uploadPct}%`
              : busy
                ? 'Working…'
                : 'Upload intro video'}
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
                e.target.value = '';
              }}
              className="hidden"
              disabled={busy}
            />
          </label>
          {progressBar}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-tertiary">or paste URL:</span>
            <input
              type="url"
              placeholder="YouTube, Vimeo, or .mp4 link"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              disabled={busy}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void onSetUrl()}
              disabled={busy || !urlDraft.trim()}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
            >
              <Link2 className="size-3.5" />
              Set URL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// OverviewSection — author-controlled fields rendered on the PWA's
// procedure intro screen (Job Aid "Step 0" + scroll-view top). Summary
// and minutes are debounced (the user types continuously); PPE chip
// adds/removes and skill-level changes save immediately.
function OverviewSection({
  doc,
  onChanged,
}: {
  doc: AdminDocumentDetail;
  onChanged: () => Promise<void> | void;
}) {
  const toast = useToast();
  const meta = doc.procedureMetadata;
  // Read-time tolerant: accept either the canonical RequiredTools shape
  // or a legacy flat array (procedures persisted before the split).
  function readTools(
    raw: AdminProcedureDocMetadata['toolsRequired'] | string[] | undefined,
  ): { common: string[]; special: string[]; consumables: string[] } {
    if (Array.isArray(raw)) {
      return { common: raw, special: [], consumables: [] };
    }
    return {
      common: raw?.common ?? [],
      special: raw?.special ?? [],
      consumables: raw?.consumables ?? [],
    };
  }
  const initialTools = readTools(meta?.toolsRequired);
  const [summary, setSummary] = useState(meta?.summary ?? '');
  const [minutesStr, setMinutesStr] = useState(
    meta?.estimatedMinutes != null ? String(meta.estimatedMinutes) : '',
  );
  const [commonTools, setCommonTools] = useState<string[]>(initialTools.common);
  const [specialTools, setSpecialTools] = useState<string[]>(initialTools.special);
  const [consumables, setConsumables] = useState<string[]>(initialTools.consumables);
  const [commonDraft, setCommonDraft] = useState('');
  const [specialDraft, setSpecialDraft] = useState('');
  const [consumableDraft, setConsumableDraft] = useState('');
  const [skillLevel, setSkillLevel] = useState<
    'basic' | 'intermediate' | 'advanced' | ''
  >(meta?.skillLevel ?? '');
  const [category, setCategory] = useState<
    'preventive_maintenance' | 'removal_replacement' | 'troubleshooting' | 'walkthrough' | ''
  >(meta?.category ?? '');

  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minutesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync local state when the parent reloads the doc (e.g. after a
  // separate save). The doc id is the cheapest "this might be a fresh
  // doc" signal — for same-doc reloads we trust local state to be ahead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSummary(meta?.summary ?? '');
    setMinutesStr(
      meta?.estimatedMinutes != null ? String(meta.estimatedMinutes) : '',
    );
    const t = readTools(meta?.toolsRequired);
    setCommonTools(t.common);
    setSpecialTools(t.special);
    setConsumables(t.consumables);
    setSkillLevel(meta?.skillLevel ?? '');
    setCategory(meta?.category ?? '');
  }, [doc.id]);

  // Always send the full metadata shape so a single-field PATCH doesn't
  // clobber tools/safety/verification/heroVideo. Mirrors HeroVideoSection.
  function buildMetadata(
    patch: Partial<AdminProcedureDocMetadata>,
  ): AdminProcedureDocMetadata {
    const base = doc.procedureMetadata ?? {
      toolsRequired: { common: [], special: [], consumables: [] },
      safety: { enabled: false, notes: null },
      verification: { enabled: false, notes: null },
    };
    // Coerce legacy flat-array toolsRequired on the way out — the API
    // accepts both shapes but the server-normalized one is canonical.
    const baseTools = Array.isArray(base.toolsRequired)
      ? { common: base.toolsRequired, special: [], consumables: [] }
      : base.toolsRequired;
    return { ...base, toolsRequired: baseTools, ...patch };
  }

  async function save(patch: Partial<AdminProcedureDocMetadata>) {
    try {
      await updateAdminDocument(doc.id, {
        procedureMetadata: buildMetadata(patch),
      });
      await onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(`Save failed: ${message}`);
    }
  }

  function onSummaryChange(next: string) {
    setSummary(next);
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(() => {
      const trimmed = next.trim();
      void save({ summary: trimmed.length > 0 ? trimmed : null });
    }, 600);
  }

  function onMinutesChange(next: string) {
    // Allow empty (clears the field) and any non-negative integer.
    setMinutesStr(next);
    if (minutesTimer.current) clearTimeout(minutesTimer.current);
    minutesTimer.current = setTimeout(() => {
      if (next.trim() === '') {
        void save({ estimatedMinutes: null });
        return;
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return;
      void save({ estimatedMinutes: n });
    }, 600);
  }

  type ToolBucket = 'common' | 'special' | 'consumables';
  function currentTools(): { common: string[]; special: string[]; consumables: string[] } {
    return { common: commonTools, special: specialTools, consumables };
  }
  function setBucket(bucket: ToolBucket, next: string[]) {
    if (bucket === 'common') setCommonTools(next);
    else if (bucket === 'special') setSpecialTools(next);
    else setConsumables(next);
  }
  function addToolTo(bucket: ToolBucket, draft: string, clearDraft: () => void) {
    const v = draft.trim();
    if (!v) {
      clearDraft();
      return;
    }
    const all = currentTools();
    if (all[bucket].includes(v)) {
      clearDraft();
      return;
    }
    const nextBucket = [...all[bucket], v];
    setBucket(bucket, nextBucket);
    clearDraft();
    void save({ toolsRequired: { ...all, [bucket]: nextBucket } });
  }
  function removeToolFrom(bucket: ToolBucket, item: string) {
    const all = currentTools();
    const nextBucket = all[bucket].filter((x) => x !== item);
    setBucket(bucket, nextBucket);
    void save({ toolsRequired: { ...all, [bucket]: nextBucket } });
  }

  function onSkillLevelChange(next: string) {
    const v = next === '' ? '' : (next as 'basic' | 'intermediate' | 'advanced');
    setSkillLevel(v);
    void save({ skillLevel: v === '' ? null : v });
  }

  function onCategoryChange(next: string) {
    const v =
      next === ''
        ? ''
        : (next as
            | 'preventive_maintenance'
            | 'removal_replacement'
            | 'troubleshooting'
            | 'walkthrough');
    setCategory(v);
    void save({ category: v === '' ? null : v });
  }

  return (
    <div className="rounded-lg border border-line-subtle bg-surface-raised p-4">
      <div className="mb-3 flex items-center gap-2">
        <Info className="size-4 text-accent" />
        <h3 className="text-sm font-semibold text-ink-primary">Overview</h3>
        <span className="text-xs text-ink-tertiary">
          Shown on the tech&apos;s intro screen before they start
        </span>
      </div>

      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-secondary">Summary</span>
          <textarea
            value={summary}
            onChange={(e) => onSummaryChange(e.target.value)}
            placeholder="What is this procedure and when should a tech run it?"
            rows={3}
            maxLength={5000}
            className="min-h-[72px] rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-xs font-medium text-ink-secondary">
              <Clock className="size-3.5" /> Estimated time (minutes)
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={60 * 24}
              value={minutesStr}
              onChange={(e) => onMinutesChange(e.target.value)}
              placeholder="—"
              className="w-32 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-secondary">Skill level</span>
            <select
              value={skillLevel}
              onChange={(e) => onSkillLevelChange(e.target.value)}
              className="w-44 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary focus:border-accent focus:outline-none"
            >
              <option value="">— Not set —</option>
              <option value="basic">Basic</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </select>
          </label>

          {/* Category drives the PWA Maintenance tab bucket. Explicit
              picker so the categorization stops depending on the title
              matching a keyword regex (a duplicate or renamed procedure
              used to silently land in the wrong card). */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-secondary">
              Category
            </span>
            <select
              value={category}
              onChange={(e) => onCategoryChange(e.target.value)}
              className="w-56 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary focus:border-accent focus:outline-none"
              title="Which Maintenance tab card this procedure surfaces under"
            >
              <option value="">— Auto (infer from title) —</option>
              <option value="preventive_maintenance">Preventive Maintenance</option>
              <option value="removal_replacement">Removal &amp; Replacement</option>
              <option value="troubleshooting">Troubleshooting</option>
              <option value="walkthrough">Walkthrough / other</option>
            </select>
          </label>
        </div>

        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-1 text-xs font-medium text-ink-secondary">
            <Wrench className="size-3.5" /> Required tools
          </span>
          <ToolBucketEditor
            label="Common tools"
            placeholder="e.g. Adjustable wrench, multimeter"
            items={commonTools}
            draft={commonDraft}
            setDraft={setCommonDraft}
            onAdd={() => addToolTo('common', commonDraft, () => setCommonDraft(''))}
            onRemove={(item) => removeToolFrom('common', item)}
          />
          <ToolBucketEditor
            label="Special tools"
            placeholder="e.g. Torque wrench (10–30 N·m), bearing puller"
            items={specialTools}
            draft={specialDraft}
            setDraft={setSpecialDraft}
            onAdd={() => addToolTo('special', specialDraft, () => setSpecialDraft(''))}
            onRemove={(item) => removeToolFrom('special', item)}
          />
          <ToolBucketEditor
            label="Consumables"
            placeholder="e.g. Loctite 243, replacement O-rings"
            items={consumables}
            draft={consumableDraft}
            setDraft={setConsumableDraft}
            onAdd={() => addToolTo('consumables', consumableDraft, () => setConsumableDraft(''))}
            onRemove={(item) => removeToolFrom('consumables', item)}
          />
        </div>
      </div>
    </div>
  );
}

// Small reusable chip-list editor used for each Required Tools bucket.
// Behavior: Enter adds, X removes, duplicates dedupe silently. Keeps
// OverviewSection's render tree readable.
function ToolBucketEditor({
  label,
  placeholder,
  items,
  draft,
  setDraft,
  onAdd,
  onRemove,
}: {
  label: string;
  placeholder: string;
  items: string[];
  draft: string;
  setDraft: (next: string) => void;
  onAdd: () => void;
  onRemove: (item: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line-subtle bg-surface px-3 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
        {label}
      </span>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-raised px-2.5 py-1 text-xs text-ink-primary"
            >
              <span>{item}</span>
              <button
                type="button"
                onClick={() => onRemove(item)}
                aria-label={`Remove ${item}`}
                className="rounded-full text-ink-tertiary hover:text-signal-fault"
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={placeholder}
          maxLength={200}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!draft.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}
