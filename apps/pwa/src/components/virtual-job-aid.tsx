'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Film,
  FileText,
  GraduationCap,
  Info,
  LayoutList,
  Lightbulb,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-react';
import {
  getProcedureDoc,
  speak,
  type ProcedureDocFullDto,
  type ProcedureStepCategoryDto,
  type StepBlock,
} from '@/lib/api';
import { CategoryIcon } from './procedure-runner/category-icon';
import { VirtualJobAidReels, type ReelsViewportHandle } from './virtual-job-aid-reels';
import { StepVideoPlayer } from './step-video-player';
import { HeroVideoEmbed } from './hero-video-embed';
import { MuxClipPlayer } from './mux-clip-player';
import { capitalize, formatDuration } from '@/lib/format';

// VirtualJobAid — hands-free, step-at-a-time procedure walkthrough that
// the AI launches by emitting a [procedure:UUID] directive. Each step
// auto-plays via TTS when shown; tech taps Replay to re-hear it, Next to
// advance, Prev to go back.
//
// Distinct from ProcedureDocViewer (read whole doc) and ProcedureRunner
// (capture evidence). This is the "virtual job aid" mode — voice-first,
// no evidence capture, no scrolling. Closing returns to the caller.

// The runner accepts either an authored procedure (looked up by docId)
// or inline step data emitted by the AI's [steps] directive. Both sources
// normalize to the same internal shape so the UI is identical.
export type JobAidSource =
  | { kind: 'doc'; docId: string; devUserId: string; devOrgId: string }
  | {
      kind: 'inline';
      title: string;
      steps: Array<{ title: string; bodyMarkdown?: string | null; safetyCritical?: boolean }>;
    };

interface Props {
  source: JobAidSource;
  /** Called when the tech taps Close or finishes the last step. */
  onClose: (state: { completed: boolean }) => void;
  /** Speak step content automatically when shown? Default true. */
  autoSpeak?: boolean;
  /** Call-stack of parent procedure titles when this instance is rendered
   *  as a nested sub-procedure. Drives the breadcrumb at the top of the
   *  header ("Inspection › Belt Replacement") and the depth limit on
   *  pushing further sub-procedures. Default [] = top-level. */
  breadcrumb?: string[];
  /** Optional step-ID filter — when set, only steps whose id is in this
   *  list render (preserving the linked doc's natural ordering). Used
   *  by sub-procedure pushes where the parent step pinned a specific
   *  subset. Empty / omitted = play all loaded steps. */
  stepIdsFilter?: string[];
  /** Optional jump-to-step. When set, the runner mounts at this step
   *  instead of the intro / Step 1. Used by voice-search deep links so
   *  the tech lands directly on the matched step. The intro panel is
   *  suppressed in this mode — we assume the tech already knows what
   *  they're looking at and want the answer immediately. */
  initialStepId?: string;
}

// Max nesting depth — refuse to push a sub-procedure deeper than this so
// authored loops (A → B → A → …) can't run away. 3 is generous in practice
// (parent → child → grandchild); a deeper stack reads as a procedure
// modeling problem.
const MAX_SUB_PROCEDURE_DEPTH = 3;

// Internal normalized shape — what the renderer actually consumes.
interface ResolvedJobAid {
  title: string;
  /** When set, render a "Step 0" intro panel before the step list with
   *  the procedure's hero video plus the author's overview metadata. */
  intro: {
    heroVideoUrl: string | null;
    heroVideoCaption: string | null;
    summary: string | null;
    estimatedMinutes: number | null;
    skillLevel: 'basic' | 'intermediate' | 'advanced' | null;
    toolsCommon: string[];
    toolsSpecial: string[];
    toolsConsumables: string[];
    safetyNotes: string | null;
  } | null;
  steps: Array<{
    /** The source step's id (procedure_steps row UUID). null when the
     *  source is inline / AI-emitted (no DB row exists). Used by voice-
     *  search deep links to jump straight to a specific step. */
    id: string | null;
    title: string;
    bodyMarkdown: string | null;
    blocks: StepBlock[];
    safetyCritical: boolean;
    media: Array<
      | {
          kind: 'image';
          url?: string | null;
          caption?: string;
          storageKey: string;
        }
      | {
          kind: 'video';
          url?: string | null;
          caption?: string;
          storageKey: string;
        }
      | {
          kind: 'video_clip';
          url?: string | null;
          caption?: string;
          storageKey: string;
          /** Mux HLS clip range — produced by the AI walkthrough drafter.
           *  Runner plays [startMs..endMs] on a loop via MuxClipPlayer. */
          clip: {
            playbackId: string;
            startMs: number;
            endMs: number;
            streamUrl: string;
            /** Full source-asset HLS URL, when the API supplies it.
             *  When present, MuxClipPlayer streams this and clamps to
             *  [startMs..endMs] for frame-accurate looping. Falls back
             *  to the segment-aligned streamUrl on older responses. */
            sourceStreamUrl?: string;
            aspectRatio?: string;
            orientation?: 'portrait' | 'landscape' | 'square';
          };
        }
    >;
    substeps: Array<{ id?: string; title: string; bodyMarkdown?: string | null }>;
    /** When the author attached or generated a voiceover, this URL plays
     *  instead of synthesizing TTS at run time. */
    audioUrl: string | null;
    /** Section context for this step. null = ungrouped (orphan), otherwise
     *  the section title to pin in the header so the tech always sees which
     *  phase they're in (Removal vs Replacement, etc.). */
    sectionLabel: string | null;
    /** 1-based position within this step's section. Restarts at 1 when
     *  crossing a section boundary. For orphan steps and ungrouped procedures
     *  this matches the overall index. */
    sectionStepIndex: number;
    /** Total steps in this step's section — denominator for the "step 3 of 7
     *  in Removal" display. */
    sectionStepTotal: number;
    /** Sub-procedure link summary. When set, the renderer shows a "Run
     *  sub-procedure" button below the step content that pushes the
     *  linked procedure as a nested Job Aid. */
    linkedSubProcedure: {
      docId: string;
      title: string;
      /** Optional step-ID subset. Empty = play the full linked procedure.
       *  When set, the nested VirtualJobAid filters its steps to just
       *  these IDs (preserving the linked doc's natural ordering). */
      stepIds: string[];
    } | null;
    /** Per-step category override (when the author tagged this step with
     *  a category distinct from the section's). Drives a small badge
     *  above the step title; when matching the section's category, the
     *  badge is suppressed to avoid visual duplication with the strip. */
    category: ProcedureStepCategoryDto | null;
  }>;
  /** Phase descriptors derived from sections. One entry per consecutive
   *  run of steps sharing a sectionId, with the section's category color
   *  (or a neutral default). Powers the phase-progress strip; empty for
   *  ungrouped procedures (the renderer falls back to the dot strip). */
  phases: Array<{
    /** Section id, or null for the orphan synthetic group. */
    key: string | null;
    label: string;
    color: string;
    icon: string | null;
    /** Inclusive start, exclusive end into the resolved steps array. */
    start: number;
    end: number;
  }>;
}

function normalizeFromDoc(doc: ProcedureDocFullDto, stepIdsFilter?: string[]): ResolvedJobAid {
  const meta = doc.metadata;
  const hero = meta?.heroVideo ?? null;
  const safety = meta?.safety;
  const summary = meta?.summary?.trim() ?? '';
  // Accept legacy flat array OR the canonical { common, special,
  // consumables } shape. API serves canonical now; legacy fallback is
  // a safety net for clients with stale cached payloads.
  const rawTools = meta?.toolsRequired;
  const tools = Array.isArray(rawTools)
    ? { common: rawTools as string[], special: [], consumables: [] }
    : {
        common: rawTools?.common ?? [],
        special: rawTools?.special ?? [],
        consumables: rawTools?.consumables ?? [],
      };
  const anyTools =
    tools.common.length > 0 || tools.special.length > 0 || tools.consumables.length > 0;
  const safetyNotes =
    safety?.enabled && safety.notes && safety.notes.trim().length > 0 ? safety.notes : null;
  // The intro panel renders when there's *anything* meaningful to show —
  // hero video, overview text, or any chip list. Otherwise techs go
  // straight to Step 1.
  const hasIntroContent =
    hero != null ||
    summary.length > 0 ||
    (meta?.estimatedMinutes != null && meta.estimatedMinutes >= 0) ||
    meta?.skillLevel != null ||
    anyTools ||
    safetyNotes != null;
  const steps = buildSectionedSteps(doc, stepIdsFilter);
  return {
    title: doc.document.title,
    intro: hasIntroContent
      ? {
          heroVideoUrl: hero?.url ?? null,
          heroVideoCaption: hero?.caption ?? null,
          summary: summary.length > 0 ? summary : null,
          estimatedMinutes: meta?.estimatedMinutes ?? null,
          skillLevel: meta?.skillLevel ?? null,
          toolsCommon: tools.common,
          toolsSpecial: tools.special,
          toolsConsumables: tools.consumables,
          safetyNotes,
        }
      : null,
    steps,
    phases: buildPhases(doc.sections, steps, doc.steps),
  };
}

// Resort the document's steps into (section.orderingHint, step.orderingHint)
// order and attach per-section metadata. The API sorts steps only by
// step.orderingHint, which interleaves Replacement steps into Removal when
// they share a hint. This was visible to users as "steps out of order" in
// Job Aid; here we normalize once at load.
function buildSectionedSteps(
  doc: ProcedureDocFullDto,
  stepIdsFilter?: string[],
): ResolvedJobAid['steps'] {
  const sections = doc.sections ?? [];
  const orderById = new Map<string, number>(sections.map((sec) => [sec.id, sec.orderingHint]));
  const titleById = new Map<string, string>(sections.map((sec) => [sec.id, sec.title]));
  // Apply the optional subset filter before sorting + numbering so the
  // per-section indices reflect what the tech actually sees. The filter
  // preserves the linked doc's natural order — we just skip non-selected
  // steps; we don't reorder them by the parent's selection sequence.
  const baseSteps =
    stepIdsFilter && stepIdsFilter.length > 0
      ? doc.steps.filter((s) => stepIdsFilter.includes(s.id))
      : doc.steps;
  const sorted = [...baseSteps].sort((a, b) => {
    const sa = a.sectionId == null ? -1 : (orderById.get(a.sectionId) ?? Infinity);
    const sb = b.sectionId == null ? -1 : (orderById.get(b.sectionId) ?? Infinity);
    if (sa !== sb) return sa - sb;
    return a.orderingHint - b.orderingHint;
  });
  // Pre-compute per-section totals so each step knows its own denominator.
  const totalsBySection = new Map<string | null, number>();
  for (const s of sorted) {
    const k = s.sectionId ?? null;
    totalsBySection.set(k, (totalsBySection.get(k) ?? 0) + 1);
  }
  // Walk the sorted list assigning per-section 1-based indices.
  const indexBySection = new Map<string | null, number>();
  return sorted.map((s) => {
    const sectionKey = s.sectionId ?? null;
    const nextIdx = (indexBySection.get(sectionKey) ?? 0) + 1;
    indexBySection.set(sectionKey, nextIdx);
    const augmented = s as ProcedureDocFullDto['steps'][number] & {
      audioUrl?: string | null;
      blocks?: StepBlock[];
      linkedProcedureDoc?: { id: string; title: string } | null;
      linkedProcedureStepIds?: string[];
    };
    return {
      id: s.id,
      title: s.title,
      bodyMarkdown: s.bodyMarkdown ?? null,
      blocks: augmented.blocks ?? [],
      safetyCritical: s.safetyCritical,
      media: s.media,
      substeps: s.substeps,
      audioUrl: augmented.audioUrl ?? null,
      sectionLabel: s.sectionId == null ? null : (titleById.get(s.sectionId) ?? null),
      sectionStepIndex: nextIdx,
      sectionStepTotal: totalsBySection.get(sectionKey) ?? 1,
      linkedSubProcedure: augmented.linkedProcedureDoc
        ? {
            docId: augmented.linkedProcedureDoc.id,
            title: augmented.linkedProcedureDoc.title,
            stepIds: augmented.linkedProcedureStepIds ?? [],
          }
        : null,
      category: s.category ?? null,
    };
  });
}

// Walk the resolved (already-section-sorted) step list and emit one
// phase per consecutive run of steps sharing a sectionId. Resolves the
// section's category color/icon for each phase; falls back to a neutral
// blue when no category is set. Returns an empty array for procedures
// with no sections — the renderer then falls back to the per-step dot
// strip.
function buildPhases(
  sections: ProcedureDocFullDto['sections'],
  resolvedSteps: ResolvedJobAid['steps'],
  rawSteps: ProcedureDocFullDto['steps'],
): ResolvedJobAid['phases'] {
  if (!sections || sections.length === 0) return [];
  // Map resolved step indices back to their source step rows so we can
  // read sectionId. resolvedSteps preserves the same order as rawSteps
  // after sorting, so we pre-index by id once.
  const sectionIdByStepId = new Map<string, string | null>();
  for (const r of rawSteps) sectionIdByStepId.set(r.id, r.sectionId ?? null);
  const sectionById = new Map(sections.map((sec) => [sec.id, sec]));
  const phases: ResolvedJobAid['phases'] = [];
  let i = 0;
  while (i < resolvedSteps.length) {
    const start = i;
    const startStep = resolvedSteps[start]!;
    const currentSecId = startStep.id ? sectionIdByStepId.get(startStep.id) ?? null : null;
    let j = i + 1;
    while (
      j < resolvedSteps.length &&
      (resolvedSteps[j]!.id ? sectionIdByStepId.get(resolvedSteps[j]!.id!) ?? null : null) ===
        currentSecId
    ) {
      j += 1;
    }
    const sec = currentSecId ? sectionById.get(currentSecId) : null;
    phases.push({
      key: currentSecId,
      label: sec ? sec.title || sec.category?.name || 'Steps' : 'Steps',
      color: sec?.category?.color ?? '#2563EB',
      icon: sec?.category?.icon ?? null,
      start,
      end: j,
    });
    i = j;
  }
  return phases;
}

function normalizeFromInline(inline: Extract<JobAidSource, { kind: 'inline' }>): ResolvedJobAid {
  return {
    title: inline.title,
    // Inline source (AI-emitted steps) never carries a hero video.
    intro: null,
    steps: inline.steps.map((s, i) => ({
      id: null,
      title: s.title,
      bodyMarkdown: s.bodyMarkdown ?? null,
      blocks: [],
      safetyCritical: !!s.safetyCritical,
      media: [],
      substeps: [],
      audioUrl: null,
      // AI-emitted inline steps don't carry section info — render the
      // existing "Step X / N" header by treating the whole list as one
      // implicit section.
      sectionLabel: null,
      sectionStepIndex: i + 1,
      sectionStepTotal: inline.steps.length,
      // Inline source has no procedure-doc references.
      linkedSubProcedure: null,
      category: null,
    })),
    // Inline AI-emitted lists have no authored sections — fall back to
    // the per-step dot strip by leaving phases empty.
    phases: [],
  };
}

export function VirtualJobAid({
  source,
  onClose,
  autoSpeak = true,
  breadcrumb = [],
  stepIdsFilter,
  initialStepId,
}: Props): React.ReactElement {
  const [resolved, setResolved] = useState<ResolvedJobAid | null>(
    source.kind === 'inline' ? normalizeFromInline(source) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  // Sub-procedure stack: when the tech taps "Run sub-procedure" on a step
  // that carries a linkedSubProcedure, we push that doc onto the stack
  // and mount a nested VirtualJobAid as an overlay. The nested instance
  // can itself push deeper. On close (X or completion), the overlay
  // unmounts and the tech lands back on the same step here.
  //
  // Push state carries both the docId and the optional step-ID subset so
  // the nested instance can trim its loaded steps to just the rows the
  // parent step pinned ("just steps 3-5 of Belt Replacement").
  const [subProcedurePush, setSubProcedurePush] = useState<{
    docId: string;
    stepIds: string[];
  } | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  // Section transition divider. When the tech advances *forward* into a
  // step that begins a new phase (e.g., from the last Removal step into
  // the first Replacement step), we interpose a one-screen divider that
  // names the section they're entering. Gives a clear "you finished X,
  // starting Y" beat. Cleared by Next (reveal the step) or Prev (drop
  // back to the last step of the previous section).
  const [showSectionDivider, setShowSectionDivider] = useState(false);
  // Layout mode. The default is derived from the procedure type, not a
  // global preference: AI walkthroughs (every step is a portrait
  // video_clip emitted by the AI drafter) open in Reels; everything
  // else — tech-authored procedures, OEM content, mixed media — opens
  // in classic. The toolbar toggle still lets the tech flip for the
  // current procedure, but does not persist across procedures so
  // opening a standard procedure never inherits an AI walkthrough's
  // Reels state.
  const [mode, setMode] = useState<'classic' | 'reels'>('classic');
  const userToggledModeRef = useRef(false);
  const reelsHandleRef = useRef<ReelsViewportHandle | null>(null);
  // Clear the legacy cross-procedure preference key. An earlier build
  // persisted `mode` globally, which made standard procedures inherit
  // "reels" once the user had switched on an AI walkthrough. Drop the
  // key on mount so it stops influencing anything.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem('eh:vja:mode:v1');
    } catch {
      // ignore — storage disabled / quota
    }
  }, []);
  // Type-derived default. Sets explicitly in both branches so a stale
  // mode from a prior render (or a sub-procedure push) can't carry
  // over. The userToggledModeRef gate keeps the tech's in-session
  // choice sticky once they've actually pressed the toggle.
  useEffect(() => {
    if (!resolved || userToggledModeRef.current) return;
    const isAiVerticalProcedure =
      resolved.steps.length > 0 &&
      resolved.steps.every((s) =>
        s.media.some(
          (m) => m.kind === 'video_clip' && m.clip.orientation === 'portrait',
        ),
      );
    setMode(isAiVerticalProcedure ? 'reels' : 'classic');
  }, [resolved]);
  function toggleMode() {
    setMode((cur) => {
      userToggledModeRef.current = true;
      return cur === 'reels' ? 'classic' : 'reels';
    });
  }
  // When the procedure has a hero video, we show a "Step 0" intro panel
  // before the first real step. true = on the intro, false = stepIdx
  // governs. We initialize true at top level and drop it once we know
  // the resolved doc has no hero. Nested sub-procedure pushes always
  // start at step 0 — the tech just chose to "Run sub-procedure" and
  // expects to be working immediately, not to watch another intro.
  const isNested = breadcrumb.length > 0;
  const [showHeroIntro, setShowHeroIntro] = useState(!isNested && !initialStepId);
  useEffect(() => {
    if (resolved && !resolved.intro) setShowHeroIntro(false);
  }, [resolved]);

  // Voice-search deep-link jump. When `initialStepId` is set, find the
  // matching step's index in the resolved list and seek to it once. We
  // only fire when resolved is non-null AND stepIdx is still at the
  // initial 0 (don't clobber the tech's manual navigation if the prop
  // changes mid-session).
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (!initialStepId || !resolved || jumpedRef.current) return;
    const idx = resolved.steps.findIndex((s) => s.id === initialStepId);
    if (idx >= 0) {
      setStepIdx(idx);
      setShowHeroIntro(false);
    }
    jumpedRef.current = true;
  }, [initialStepId, resolved]);
  // Completion summary panel shown after the tech finishes the last step,
  // before this instance closes. Replaces the prior behavior of closing
  // immediately on Finish — techs reported they wanted a moment to
  // acknowledge they finished (and the option to step back if they
  // tapped Next by accident).
  const [showCompletion, setShowCompletion] = useState(false);
  // Imperative refs for audio so React state changes don't restart playback.
  // Two playback paths coexist:
  //   - audio element  → plays an authored mp3 from a URL (preferred when
  //                      step.audioUrl is set; uses HTML5 streaming).
  //   - WebAudio source → plays a Blob fetched from /ai/voice/speak (TTS
  //                      fallback when no authored audio exists).
  // Only one path runs at a time; stopPlayback tears down whichever is live.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Shared <audio> element reused across every step. iOS Safari only
  // honors the page's media-playback activation for elements that
  // existed at the time of the original user gesture (the tap that
  // opened the runner). Creating a fresh `new Audio()` for each step
  // — particularly inside an async callback fired off the scroll-
  // settle timer, several hops removed from the swipe gesture — gets
  // its `.play()` silently rejected after a handful of swipes, which
  // is exactly the "voiceover stops working" symptom. Re-pointing one
  // long-lived element's `.src` keeps the activation alive.
  const sharedAudioRef = useRef<HTMLAudioElement | null>(null);
  // Marks whichever audio element is the "currently speaking" one. With
  // the shared element above this is almost always === sharedAudioRef,
  // but the indirection lets stopPlayback null it out without touching
  // the shared element so the next speakCurrent can re-attach cleanly.
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);

  function getOrCreateSharedAudio(): HTMLAudioElement {
    if (!sharedAudioRef.current) {
      const a = new Audio();
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      sharedAudioRef.current = a;
    }
    return sharedAudioRef.current;
  }
  // Epoch counter — incremented every time playback is stopped. Each
  // speakCurrent invocation captures its epoch on entry and checks after
  // every await; if a newer epoch has taken over (e.g. user pressed Next
  // mid-fetch), the older invocation abandons before starting playback.
  // Without this the prior step's audio can complete its fetch + decode
  // after Next was pressed and play concurrently with the new step's.
  const playEpochRef = useRef(0);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Fetch the procedure once for doc-source. Inline source is already
  // resolved at mount.
  useEffect(() => {
    if (source.kind !== 'doc') return;
    let cancelled = false;
    (async () => {
      try {
        const full = await getProcedureDoc(source.docId, source.devUserId, source.devOrgId);
        if (!cancelled) setResolved(normalizeFromDoc(full, stepIdsFilter));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind === 'doc' ? source.docId : null]);

  // Tear down audio on unmount.
  useEffect(() => {
    return () => {
      stopPlayback();
      if (sharedAudioRef.current) {
        try {
          sharedAudioRef.current.pause();
          sharedAudioRef.current.removeAttribute('src');
          sharedAudioRef.current.load();
        } catch {
          // ignore
        }
        sharedAudioRef.current = null;
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
      audioCtxRef.current = null;
    };
  }, []);

  function stopPlayback() {
    playEpochRef.current++;
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        // already stopped
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (htmlAudioRef.current) {
      try {
        htmlAudioRef.current.pause();
      } catch {
        // ignore
      }
      // Detach the listeners we attached in speakCurrent so a paused
      // playback doesn't fire onended/onerror against a stale handler.
      // We deliberately do NOT clear `src` or call `load()` on the
      // shared element here — those operations on iOS can drop the
      // element's playback activation, which is the very thing we are
      // trying to preserve by reusing one element across steps. Just
      // pause + detach listeners; the next speakCurrent will swap src.
      htmlAudioRef.current.onended = null;
      htmlAudioRef.current.onerror = null;
      htmlAudioRef.current = null;
    }
    setSpeaking(false);
  }

  const speakCurrent = useCallback(async () => {
    if (muted) return;
    const step = resolved?.steps[stepIdx];
    if (!step) return;
    // stopPlayback increments the epoch — capture ours AFTER stopping so
    // we get the new value, then bail out of any subsequent async section
    // whose epoch has been bumped again.
    stopPlayback();
    const myEpoch = playEpochRef.current;
    const isStale = () => playEpochRef.current !== myEpoch;

    // Path 1 — authored voiceover. Always preferred when present: better
    // fidelity (custom emphasis, your shop voice), zero per-play cost,
    // streams from CDN. We reuse one long-lived <audio> element across
    // every step so iOS Safari preserves the media-playback activation
    // from the original tap (see sharedAudioRef note).
    if (step.audioUrl) {
      let authoredOk = false;
      const audio = getOrCreateSharedAudio();
      try {
        // Detach any listeners from a prior step's playback before we
        // swap the src — otherwise an in-flight onended from the old
        // src could fire against the new track.
        audio.onended = null;
        audio.onerror = null;
        try {
          audio.pause();
        } catch {
          // ignore
        }
        // Only re-assign src when it actually changes. Re-setting an
        // identical URL is a free no-op in Chrome but can trigger a
        // full reload on iOS, which we want to avoid for the replay
        // button case.
        if (audio.src !== step.audioUrl) {
          audio.src = step.audioUrl;
        } else {
          // Same URL (replay tap): explicitly seek to 0 so it restarts
          // instead of resuming from wherever the previous play stopped.
          try {
            audio.currentTime = 0;
          } catch {
            // ignore
          }
        }
        if (isStale()) {
          // Superseded between the muted-check and now (extremely
          // unlikely, but defensive). Don't even start playback.
          return;
        }
        htmlAudioRef.current = audio;
        setSpeaking(true);
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => {
            authoredOk = true;
            resolve();
          };
          audio.onerror = () => reject(new Error('audio load failed'));
          audio.play().then(
            () => {
              // play() resolved — playback has started. Resolve via
              // onended when the track finishes naturally.
            },
            (err) => reject(err),
          );
        });
      } catch (err) {
        console.warn(
          '[virtual-job-aid] authored audio failed, falling back to TTS',
          err,
        );
      } finally {
        audio.onended = null;
        audio.onerror = null;
        if (htmlAudioRef.current === audio) {
          htmlAudioRef.current = null;
        }
        setSpeaking(false);
      }
      // If we successfully played the authored track — or another
      // speakCurrent invocation has taken over — stop here. Otherwise
      // fall through to the TTS fallback so the tech still hears the
      // step.
      if (authoredOk || isStale()) return;
    }

    // Path 2 — live TTS fallback (used when no authored audio exists).
    // Prefer typed blocks for the spoken script; structured text reads
    // better than paraphrased markdown. Fall back to bodyMarkdown for
    // legacy procedures.
    const lead = step.safetyCritical ? 'Safety critical step. ' : '';
    // Speak the section context so the tech hears "Removal, step 3 of 7"
    // instead of a section-blind "step 10 of 20". Falls back to plain
    // "Step X of Y" for ungrouped procedures.
    const numbering = step.sectionLabel
      ? `${step.sectionLabel}, step ${step.sectionStepIndex} of ${step.sectionStepTotal}. `
      : `Step ${stepIdx + 1} of ${resolved!.steps.length}. `;
    let body = '';
    if (step.blocks.length > 0) {
      body = step.blocks
        .map((b) => {
          switch (b.kind) {
            case 'paragraph':
              return b.text;
            case 'callout':
              return `${b.tone === 'safety' || b.tone === 'warning' ? `${b.tone}. ` : ''}${b.title ? b.title + '. ' : ''}${b.text}`;
            case 'bullet_list':
            case 'numbered_list':
              return b.items.join('. ');
            case 'key_value':
              return b.rows.map(([k, v]) => `${k}, ${v}.`).join(' ');
            case 'photo_inline':
              return ''; // visual-only
          }
        })
        .filter((s) => s.trim().length > 0)
        .join(' ');
    } else if (step.bodyMarkdown) {
      body = step.bodyMarkdown
        .replace(/[#>*_`]/g, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const text = `${lead}${numbering}${step.title}.${body ? ' ' + body : ''}`;
    if (text.length === 0) return;

    let source: AudioBufferSourceNode | null = null;
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      if (isStale()) return;

      setSpeaking(true);
      const resp = await speak(text);
      if (isStale()) return;
      const buf = await resp.arrayBuffer();
      if (isStale()) return;
      const decoded = await ctx.decodeAudioData(buf);
      if (isStale()) return;

      source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      sourceRef.current = source;
      await new Promise<void>((resolve) => {
        source!.onended = () => resolve();
        source!.start();
      });
    } catch (err) {
      console.warn('[virtual-job-aid] TTS failed', err);
    } finally {
      setSpeaking(false);
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    }
  }, [resolved, stepIdx, muted]);

  // Auto-speak when the step changes — unless we're on the hero intro
  // panel, which has its own narration (a short "watch the overview"
  // line that speaks once on entry; the hero video itself stays paused
  // and muted to avoid colliding).
  useEffect(() => {
    if (!resolved || !autoSpeak || muted) return;
    if (showHeroIntro) {
      // Skip the per-step TTS path; intro narration is handled below.
      return;
    }
    if (showSectionDivider) {
      // While the divider is visible, don't auto-speak the step it
      // precedes — the voiceover would land before the tech can read
      // the section name. Auto-speak fires naturally on the next
      // stepIdx-change cycle after the tech taps Next.
      return;
    }
    void speakCurrent();
    return () => stopPlayback();
    // intentional: speakCurrent is stable enough; we want this to fire on
    // step change, not on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, stepIdx, autoSpeak, muted, showHeroIntro, showSectionDivider]);

  // No auto-narration on the intro panel — author overview content (or
  // the hero video itself) carries the orientation. Per-step TTS still
  // fires once the tech advances past the intro.

  function next() {
    if (!resolved) return;
    // Section divider → reveal the step it precedes.
    if (showSectionDivider) {
      setShowSectionDivider(false);
      return;
    }
    // Hero intro → first real step.
    if (showHeroIntro) {
      stopPlayback();
      setShowHeroIntro(false);
      return;
    }
    // Last step → completion summary (NOT immediate close). The summary
    // is a thin acknowledgement screen with a 'Mark complete' button.
    if (stepIdx >= resolved.steps.length - 1) {
      stopPlayback();
      setShowCompletion(true);
      return;
    }
    stopPlayback();
    const nextIdx = stepIdx + 1;
    setStepIdx(nextIdx);
    // Interpose the divider when the next step starts a new section run.
    // We skip the very first phase (start=0) since there's nothing to
    // "finish" yet — the hero intro already serves that orientation
    // role. Single-section procedures never trigger.
    const startsNewPhase = resolved.phases.some(
      (p) => p.start === nextIdx && p.start > 0,
    );
    if (startsNewPhase) setShowSectionDivider(true);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        // ignore
      }
    }
  }
  function prev() {
    // Section divider → drop back into the last step of the previous
    // section. The tech wanted to go back across the boundary, so the
    // divider clears in the same tap (no need to show it twice).
    if (showSectionDivider) {
      setShowSectionDivider(false);
      stopPlayback();
      setStepIdx((i) => Math.max(0, i - 1));
      return;
    }
    // Completion screen → back to last step.
    if (showCompletion) {
      setShowCompletion(false);
      return;
    }
    // First real step → hero intro (if present).
    if (stepIdx === 0) {
      if (resolved?.intro && !showHeroIntro) {
        stopPlayback();
        setShowHeroIntro(true);
      }
      return;
    }
    stopPlayback();
    setStepIdx((i) => i - 1);
  }
  function close() {
    stopPlayback();
    onClose({ completed: false });
  }
  function replay() {
    void speakCurrent();
  }
  function toggleMute() {
    setMuted((m) => {
      if (!m) stopPlayback();
      return !m;
    });
  }

  if (error && !resolved) {
    return (
      <div className="vja-root" role="dialog" aria-label="Procedure">
        <button type="button" className="vja-close" onClick={close} aria-label="Close">
          <X size={20} strokeWidth={2.25} />
        </button>
        <div className="vja-error">
          <p>Couldn&apos;t load the procedure.</p>
          <p className="vja-error-detail">{error}</p>
        </div>
      </div>
    );
  }
  if (!resolved) {
    return (
      <div className="vja-root" role="dialog" aria-label="Loading procedure">
        <div className="vja-loading">Loading procedure…</div>
      </div>
    );
  }

  const step = resolved.steps[stepIdx];
  const isLast = stepIdx === resolved.steps.length - 1;
  const totalSteps = resolved.steps.length;

  const parentTitle = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;

  return (
    <div
      className="vja-root"
      role="dialog"
      aria-label={resolved.title}
      data-nested={isNested ? 'true' : undefined}
    >
      {/* Sub-procedure banner — only when nested. Spans full width above the
          topbar so it's the first thing the tech sees. Tapping ← closes this
          nested instance and lands back on the parent step. */}
      {isNested && (
        <div className="vja-subproc-banner" role="region" aria-label="Sub-procedure">
          <button
            type="button"
            className="vja-subproc-back"
            onClick={close}
            aria-label={parentTitle ? `Back to ${parentTitle}` : 'Back to parent procedure'}
          >
            <ChevronLeft size={18} strokeWidth={2.5} />
            <span>Back</span>
          </button>
          <div className="vja-subproc-banner-text">
            <span className="vja-subproc-banner-kicker">SUB-PROCEDURE</span>
            {parentTitle && (
              <span className="vja-subproc-banner-parent">
                of <strong>{parentTitle}</strong>
              </span>
            )}
          </div>
        </div>
      )}
      <header className="vja-topbar">
        <div className="vja-topbar-meta">
          <span className="caption inline-flex items-center gap-1.5">
            <ListChecks size={12} strokeWidth={1.75} />
            Virtual job aid
          </span>
          <h2 className="vja-doc-title">
            {resolved.title}
            {/* "subset" pill — tech-visible cue that this instance was
                pushed with a step-ID filter, not the whole procedure. */}
            {stepIdsFilter && stepIdsFilter.length > 0 && (
              <span className="vja-subset-pill">
                subset / {resolved.steps.length} step
                {resolved.steps.length === 1 ? '' : 's'}
              </span>
            )}
          </h2>
        </div>
        <button
          type="button"
          className="vja-mute"
          onClick={toggleMode}
          aria-label={mode === 'reels' ? 'Switch to classic view' : 'Switch to Reels mode'}
          aria-pressed={mode === 'reels'}
          title={mode === 'reels' ? 'Classic view' : 'Reels mode (vertical swipe)'}
        >
          {mode === 'reels' ? (
            <LayoutList size={18} strokeWidth={2} />
          ) : (
            <Film size={18} strokeWidth={2} />
          )}
        </button>
        <button
          type="button"
          className="vja-mute"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX size={18} strokeWidth={2} /> : <Volume2 size={18} strokeWidth={2} />}
        </button>
        <button type="button" className="vja-close" onClick={close} aria-label="Close">
          <X size={20} strokeWidth={2.25} />
        </button>
      </header>

      {/* Progress strip — when the procedure has authored sections, render
          the phase-progress strip (one labeled segment per section, color
          from the section's category). For ungrouped procedures fall
          back to the per-step dot strip. Hidden on the hero intro panel
          since no step is "active" yet. */}
      {!showHeroIntro && resolved.phases.length > 0 && (
        <nav className="vja-phases" aria-label="Procedure phases">
          {resolved.phases.map((p) => {
            const total = p.end - p.start;
            const doneInPhase = showCompletion
              ? total
              : Math.max(0, Math.min(total, stepIdx - p.start));
            const isActive = !showCompletion && stepIdx >= p.start && stepIdx < p.end;
            const pct = total > 0 ? Math.round((doneInPhase / total) * 100) : 0;
            return (
              <button
                type="button"
                key={p.key ?? '__orphans__'}
                onClick={() => setStepIdx(p.start)}
                className="vja-phase"
                aria-label={`${p.label} — ${doneInPhase} of ${total} done${isActive ? ', current phase' : ''}`}
                aria-current={isActive ? 'step' : undefined}
                data-active={isActive ? 'true' : 'false'}
              >
                <span
                  className="vja-phase-label"
                  style={isActive ? { color: p.color } : undefined}
                >
                  <CategoryIcon name={p.icon} size={12} strokeWidth={2.25} />
                  {p.label}
                </span>
                <span className="vja-phase-bar" aria-hidden>
                  <span
                    className="vja-phase-fill"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: p.color,
                      opacity: isActive ? 1 : 0.6,
                    }}
                  />
                </span>
              </button>
            );
          })}
        </nav>
      )}
      {!showHeroIntro && resolved.phases.length === 0 && (
        <div className="vja-progress" aria-hidden>
          {resolved.steps.map((_, i) => (
            <span
              key={i}
              className="vja-progress-seg"
              data-state={
                showCompletion || i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'pending'
              }
            />
          ))}
        </div>
      )}

      {/* IMAGE-PROMINENT HERO — rendered OUTSIDE .vja-main so it spans
          the full width of .vja-root, edge to edge. No text overlay;
          the title and chips render inside .vja-hero-intro below so the
          video frame stays uncovered. */}
      {showHeroIntro && resolved.intro?.heroVideoUrl && (
        <div className="vja-hero-overlay-block">
          <HeroVideoEmbed
            url={resolved.intro.heroVideoUrl}
            caption={resolved.intro.heroVideoCaption ?? null}
            muted={false}
            playId="hero"
            alt={`${resolved.title} intro video`}
          />
        </div>
      )}

      {/* Reels mode — vertical-swipe video reader. Only renders when:
          (a) the user is in reels mode, (b) we're past the hero intro,
          (c) we're not on the completion screen. The intro + completion
          surfaces stay in their classic single-screen layout — neither
          one fits the reel model (the intro is pre-procedure orientation;
          completion is a confirmation, not a step). */}
      {mode === 'reels' && !showHeroIntro && !showCompletion && (
        <VirtualJobAidReels
          ref={reelsHandleRef}
          steps={resolved.steps}
          phases={resolved.phases}
          stepIdx={stepIdx}
          onStepChange={(next) => {
            // Settle from the reels viewport — fires after scroll stops.
            // stopPlayback so any in-flight voiceover for the previous
            // step doesn't bleed into the new one; the speakCurrent
            // useEffect will then auto-trigger fresh narration for the
            // new active step.
            if (next === stepIdx) return;
            stopPlayback();
            setStepIdx(next);
            // Jumping via the phase strip is a deliberate navigation —
            // it would be confusing to land on a divider screen when the
            // tech explicitly tapped a phase pill. Clear any pending
            // divider so the destination step renders directly.
            setShowSectionDivider(false);
          }}
          onReplayVoiceover={replay}
          speaking={speaking}
          muted={muted}
          activePhaseColor={
            resolved.phases.find((p) => stepIdx >= p.start && stepIdx < p.end)?.color ?? null
          }
        />
      )}

      <main
        className="vja-main"
        // Hide the classic main when Reels mode owns the viewport so the
        // reel container can occupy the full vertical space. Still
        // mounted so the intro + completion branches inside this block
        // can keep their classic single-screen treatments.
        data-hidden={
          mode === 'reels' && !showHeroIntro && !showCompletion ? 'true' : undefined
        }
      >
        {showCompletion && (
          <section className="vja-completion" aria-label="Procedure complete">
            <div className="vja-completion-mark" aria-hidden>
              <ListChecks size={36} strokeWidth={2} />
            </div>
            <h1 className="vja-completion-title">All steps complete</h1>
            <p className="vja-completion-sub">
              {resolved.title} — {totalSteps} step{totalSteps === 1 ? '' : 's'} reviewed.
            </p>
            <p className="vja-completion-hint">
              Tap Mark complete to close, or step back to revisit a step.
            </p>
          </section>
        )}
        {!showCompletion && showHeroIntro && resolved.intro && (
          <section className="vja-hero-intro" aria-label="Procedure intro">
            <h1 className="vja-hero-intro-title">{resolved.title}</h1>
            {(resolved.intro.estimatedMinutes != null || resolved.intro.skillLevel != null) && (
              <div className="vja-hero-intro-chips">
                {resolved.intro.estimatedMinutes != null && (
                  <span className="vja-hero-intro-chip">
                    <span className="vja-hero-intro-chip-icon">
                      <Clock size={13} strokeWidth={2.25} />
                    </span>
                    {formatDuration(resolved.intro.estimatedMinutes)}
                  </span>
                )}
                {resolved.intro.skillLevel != null && (
                  <span className="vja-hero-intro-chip">
                    <span className="vja-hero-intro-chip-icon">
                      <GraduationCap size={13} strokeWidth={2.25} />
                    </span>
                    {capitalize(resolved.intro.skillLevel)}
                  </span>
                )}
              </div>
            )}
            {(() => {
              const i = resolved.intro;
              const anyTools =
                i.toolsCommon.length > 0 ||
                i.toolsSpecial.length > 0 ||
                i.toolsConsumables.length > 0;
              if (!i.summary && !anyTools && !i.safetyNotes) return null;
              return (
                <section className="vja-hero-intro-card" aria-label="General information">
                  <h2 className="vja-hero-intro-card-header">General information</h2>
                  {anyTools && (
                    <div className="vja-hero-intro-block">
                      <h3 className="vja-hero-intro-subhead">
                        <span className="vja-hero-intro-subhead-icon">
                          <Wrench size={14} strokeWidth={2.25} />
                        </span>
                        Required tools
                      </h3>
                      <div className="vja-hero-intro-tool-groups">
                        <ToolBucketList label="Common Tools" items={i.toolsCommon} />
                        <ToolBucketList label="Special Tools" items={i.toolsSpecial} />
                        <ToolBucketList label="Consumables" items={i.toolsConsumables} />
                      </div>
                    </div>
                  )}
                  {i.summary && (
                    <div className="vja-hero-intro-block">
                      <h3 className="vja-hero-intro-subhead">
                        <span className="vja-hero-intro-subhead-icon">
                          <FileText size={14} strokeWidth={2.25} />
                        </span>
                        Description
                      </h3>
                      <p className="vja-hero-intro-summary">{i.summary}</p>
                    </div>
                  )}
                  {i.safetyNotes && (
                    <div className="vja-hero-intro-block">
                      <h3 className="vja-hero-intro-subhead">
                        <span className="vja-hero-intro-subhead-icon">
                          <ShieldAlert size={14} strokeWidth={2.25} />
                        </span>
                        Safety
                      </h3>
                      <div className="vja-hero-intro-safety">{i.safetyNotes}</div>
                    </div>
                  )}
                </section>
              );
            })()}
          </section>
        )}
        {!showCompletion && !showHeroIntro && showSectionDivider && step && (() => {
          // Render the section-transition divider in place of the step.
          // The footer's standard Prev/Next buttons handle navigation
          // (Next dismisses the divider; Prev drops back to the last
          // step of the previous section).
          const enteringPhase = resolved.phases.find(
            (p) => p.start === stepIdx,
          );
          const leavingPhase = resolved.phases.find(
            (p) => p.end === stepIdx,
          );
          const enteringLabel = enteringPhase?.label ?? step.sectionLabel ?? 'Next section';
          const enteringColor = enteringPhase?.color ?? null;
          const enteringIcon = enteringPhase?.icon ?? null;
          const leavingLabel = leavingPhase?.label ?? null;
          return (
            <section
              key={`divider-${stepIdx}`}
              className="vja-section-divider"
              role="status"
              aria-live="polite"
              aria-label={`Starting section: ${enteringLabel}`}
              style={
                enteringColor
                  ? ({ ['--vja-divider-accent' as string]: enteringColor } as Record<string, string>)
                  : undefined
              }
            >
              {leavingLabel && (
                <p className="vja-section-divider-prev">
                  Finished <strong>{leavingLabel}</strong>
                </p>
              )}
              {/* Section mark renders only when the entering section has
                  an authored category icon. We no longer fall back to a
                  generic chevron — the title alone (plus the optional
                  "Finished X" line above) carries the transition. */}
              {enteringIcon && (
                <div className="vja-section-divider-mark" aria-hidden>
                  <CategoryIcon name={enteringIcon} size={36} strokeWidth={2} />
                </div>
              )}
              <h1 className="vja-section-divider-title">{enteringLabel}</h1>
              {enteringPhase && (
                <p className="vja-section-divider-meta">
                  {enteringPhase.end - enteringPhase.start} step
                  {enteringPhase.end - enteringPhase.start === 1 ? '' : 's'} in this section
                </p>
              )}
              <p className="vja-section-divider-hint">
                Tap <strong>Next</strong> to begin, or <strong>Back</strong> to revisit the previous section.
              </p>
            </section>
          );
        })()}
        {!showCompletion && !showHeroIntro && !showSectionDivider && step && (
          <article
            key={stepIdx}
            className={`vja-step ${step.safetyCritical ? 'vja-step-safety' : ''}`}
            aria-live="polite"
          >
            <div className="vja-step-header">
              {(() => {
                // Resolve the visual treatment for this step's section
                // pill. When the phase strip is rendering above, the
                // section name is already visible there — but we still
                // want a per-step accent in the section's category color
                // (or the category override when set) so the active
                // phase ties visually to the step body.
                const phase = resolved.phases.find(
                  (p) => stepIdx >= p.start && stepIdx < p.end,
                );
                const sectionColor = phase?.color ?? null;
                const sectionIcon = phase?.icon ?? null;
                const stepCat = step.category;
                // Show the step-level category badge only when it differs
                // from the section's effective category — otherwise it's
                // visual duplication of the strip's active color.
                const showStepBadge =
                  stepCat && (!phase || stepCat.color.toLowerCase() !== phase.color.toLowerCase());
                return (
                  <>
                    {step.sectionLabel && (
                      <span
                        className="vja-section-label"
                        title={`Section: ${step.sectionLabel}`}
                        style={
                          sectionColor
                            ? {
                                color: sectionColor,
                                borderColor: sectionColor,
                                backgroundColor: `${sectionColor}1A`,
                              }
                            : undefined
                        }
                      >
                        {sectionIcon && (
                          <CategoryIcon name={sectionIcon} size={11} strokeWidth={2.25} />
                        )}
                        {step.sectionLabel}
                      </span>
                    )}
                    {showStepBadge && stepCat && (
                      <span
                        className="vja-section-label"
                        title={`Category: ${stepCat.name}`}
                        style={{
                          color: 'white',
                          backgroundColor: stepCat.color,
                          borderColor: stepCat.color,
                        }}
                      >
                        <CategoryIcon name={stepCat.icon} size={11} strokeWidth={2.25} />
                        {stepCat.name}
                      </span>
                    )}
                  </>
                );
              })()}
              <span className="vja-step-num">
                {String(step.sectionStepIndex).padStart(2, '0')}
                <span className="vja-step-of">
                  {' '}
                  / {String(step.sectionStepTotal).padStart(2, '0')}
                </span>
              </span>
              {step.safetyCritical && (
                <span className="vja-safety-pill">
                  <ShieldAlert size={12} strokeWidth={2} />
                  Safety-critical
                </span>
              )}
            </div>
            <h1 className="vja-step-title">{step.title}</h1>
            {/* Typed blocks take precedence — the template renders each
                kind with consistent visual style. Legacy procedures fall
                back to their bodyMarkdown until they're migrated. */}
            {step.blocks.length > 0 ? (
              <div className="vja-blocks">
                {step.blocks.map((b, i) => (
                  <BlockRenderer key={i} block={b} media={step.media} />
                ))}
              </div>
            ) : step.bodyMarkdown ? (
              <div className="markdown-body vja-step-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.bodyMarkdown}</ReactMarkdown>
              </div>
            ) : null}
            {/* Trailing media gallery — only media NOT already rendered
                inline by a photo_inline block. Without the filter every
                photo_inline appears twice: once in the block list, once
                in this gallery. */}
            {(() => {
              const inlineKeys = new Set(
                step.blocks
                  .filter(
                    (b): b is Extract<StepBlock, { kind: 'photo_inline' }> =>
                      b.kind === 'photo_inline',
                  )
                  .map((b) => b.storageKey),
              );
              const galleryMedia = step.media.filter((m) => !inlineKeys.has(m.storageKey));
              if (galleryMedia.length === 0) return null;
              return (
                <ul className="vja-step-media">
                  {galleryMedia.map((m, i) => (
                    <li key={`${m.storageKey}-${i}`}>
                      {m.kind === 'image' ? (
                        <FallbackImage
                          src={m.url ?? ''}
                          alt={m.caption ?? step.title}
                          label={m.caption ?? 'Image unavailable'}
                        />
                      ) : m.kind === 'video_clip' ? (
                        // AI-drafted clip — streamUrl is the Mux
                        // instant-clip URL pre-trimmed to the step's
                        // range, so the player just treats it as a
                        // standalone looping HLS source. Autoplays
                        // when the step lands; navigating to a new
                        // step unmounts this <video> element and
                        // mounts the next one.
                        <MuxClipPlayer
                          streamUrl={
                            m.clip.sourceStreamUrl ?? m.clip.streamUrl
                          }
                          // Frame-accurate clip bounds when the server
                          // returned a source URL; older responses only
                          // ship streamUrl (segment-aligned).
                          startMs={
                            m.clip.sourceStreamUrl ? m.clip.startMs : undefined
                          }
                          endMs={
                            m.clip.sourceStreamUrl ? m.clip.endMs : undefined
                          }
                          posterUrl={m.url ?? undefined}
                          alt={m.caption ?? step.title}
                          caption={m.caption ?? null}
                          autoplay
                          aspectRatio={m.clip.aspectRatio ?? null}
                          orientation={m.clip.orientation ?? null}
                        />
                      ) : (
                        // Job Aid view: muted by default so step videos
                        // don't fight TTS narration. playId keyed on the
                        // step index so navigating Next/Prev auto-pauses.
                        <StepVideoPlayer
                          src={m.url ?? ''}
                          alt={m.caption ?? step.title}
                          caption={m.caption ?? null}
                          muted
                          playId={`step-${stepIdx}-${m.storageKey}`}
                        />
                      )}
                      {/* caption is rendered overlaid by Step/Mux clip
                          players for video; keep the existing under-image
                          caption for images only. */}
                      {m.kind === 'image' && m.caption && (
                        <p className="vja-step-caption">{m.caption}</p>
                      )}
                    </li>
                  ))}
                </ul>
              );
            })()}
            {step.substeps.length > 0 && (
              <ol className="vja-substeps">
                {step.substeps.map((ss, i) => (
                  <li key={ss.id ?? i}>
                    <span className="vja-substep-num" aria-hidden>
                      {i + 1}
                    </span>
                    <span className="vja-substep-title">{ss.title}</span>
                    {ss.bodyMarkdown && (
                      <div className="markdown-body vja-substep-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{ss.bodyMarkdown}</ReactMarkdown>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {/* Linked sub-procedure call-to-action. Tapping pushes the
                linked procedure as a nested Job Aid (overlay rendered
                below this main return). Skipping is just tapping Next —
                the link is an optional branch ("if necessary"). */}
            {step.linkedSubProcedure &&
              (() => {
                const sp = step.linkedSubProcedure;
                const limitReached = breadcrumb.length >= MAX_SUB_PROCEDURE_DEPTH;
                const pinnedCount = sp.stepIds.length;
                return (
                  <div className="vja-subprocedure-cta">
                    <button
                      type="button"
                      className="vja-subproc-card"
                      disabled={limitReached}
                      onClick={() => {
                        stopPlayback();
                        setSubProcedurePush({
                          docId: sp.docId,
                          stepIds: sp.stepIds,
                        });
                      }}
                      title={
                        limitReached
                          ? `Nesting limit reached (${MAX_SUB_PROCEDURE_DEPTH} deep). Finish current sub-procedure first.`
                          : `Open ${sp.title} as a sub-procedure`
                      }
                    >
                      <div className="vja-subproc-card-body">
                        <div className="vja-subproc-card-kicker">
                          <span className="vja-subproc-card-tag">Sub-procedure</span>
                        </div>
                        <div className="vja-subproc-card-title">{sp.title}</div>
                        <div className="vja-subproc-card-meta">
                          {pinnedCount > 0
                            ? `${pinnedCount} step${pinnedCount === 1 ? '' : 's'} · tap to view`
                            : 'Tap to view the full procedure'}
                        </div>
                      </div>
                      <span className="vja-subproc-card-chevron" aria-hidden>
                        <ChevronRight size={20} strokeWidth={2.25} />
                      </span>
                    </button>
                    <span className="vja-subprocedure-hint">
                      Open to walk through the detailed steps, or tap Next to continue.
                    </span>
                  </div>
                );
              })()}
          </article>
        )}
      </main>

      <footer
        className="vja-controls"
        // Reels mode hides the bottom button bar — vertical swipes drive
        // step changes, the per-reel replay button handles voiceover.
        // Keep the bar visible on the hero intro panel and the
        // completion screen, both of which need explicit "Start" /
        // "Mark complete" affordances regardless of mode.
        data-hidden={
          mode === 'reels' && !showHeroIntro && !showCompletion ? 'true' : undefined
        }
      >
        {showCompletion ? (
          <>
            <button
              type="button"
              className="vja-btn vja-btn-ghost"
              onClick={prev}
              aria-label="Back to last step"
            >
              <ChevronLeft size={18} strokeWidth={2.25} />
              <span>Back</span>
            </button>
            <span aria-hidden />
            <button
              type="button"
              className="vja-btn vja-btn-primary"
              onClick={() => {
                stopPlayback();
                onClose({ completed: true });
              }}
              aria-label="Mark procedure complete and close"
            >
              <span>Mark complete</span>
            </button>
          </>
        ) : showHeroIntro ? (
          <>
            <button
              type="button"
              className="vja-btn vja-btn-ghost"
              onClick={close}
              aria-label="Skip intro and close"
            >
              <span>Skip</span>
            </button>
            <span aria-hidden />
            <button
              type="button"
              className="vja-btn vja-btn-primary"
              onClick={next}
              aria-label="Start procedure"
            >
              <span>Start</span>
              <ChevronRight size={18} strokeWidth={2.25} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="vja-btn vja-btn-ghost"
              onClick={prev}
              disabled={stepIdx === 0 && !resolved.intro}
              aria-label="Previous step"
            >
              <ChevronLeft size={18} strokeWidth={2.25} />
              <span>Back</span>
            </button>
            <button
              type="button"
              className="vja-btn vja-btn-secondary"
              onClick={replay}
              disabled={muted}
              aria-label="Replay step"
              title="Replay this step"
            >
              <RefreshCw size={18} strokeWidth={2.25} className={speaking ? 'vja-spin' : ''} />
              <span>Replay</span>
            </button>
            <button
              type="button"
              className="vja-btn vja-btn-primary"
              onClick={next}
              aria-label={isLast ? 'Finish' : 'Next step'}
            >
              <span>{isLast ? 'Finish' : 'Next'}</span>
              <ChevronRight size={18} strokeWidth={2.25} />
            </button>
          </>
        )}
      </footer>

      {/* Nested sub-procedure overlay — mounted when the tech tapped "Run
          sub-procedure" on the current step. Renders on top of this
          instance; closing pops back here. Recursive (the nested instance
          can push its own sub) up to MAX_SUB_PROCEDURE_DEPTH.
          stepIdsFilter forwards the parent step's pinned subset so the
          nested instance only renders those rows. */}
      {subProcedurePush && source.kind === 'doc' && (
        <VirtualJobAid
          source={{
            kind: 'doc',
            docId: subProcedurePush.docId,
            devUserId: source.devUserId,
            devOrgId: source.devOrgId,
          }}
          breadcrumb={[...breadcrumb, resolved.title]}
          stepIdsFilter={subProcedurePush.stepIds.length > 0 ? subProcedurePush.stepIds : undefined}
          autoSpeak={autoSpeak}
          onClose={() => setSubProcedurePush(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block renderer — the template that controls visual style for every block
// kind. Authors choose semantic block types (callout, list, key-value);
// this component owns the entire visual treatment so every procedure looks
// identical across the library regardless of who authored it.
// ---------------------------------------------------------------------------

function BlockRenderer({
  block,
  media,
}: {
  block: StepBlock;
  // Accepts the full step media union (image / video / video_clip) — the
  // photo_inline block looks up referenced items by storageKey and only
  // renders the image variant; other kinds are ignored.
  media: ResolvedJobAid['steps'][number]['media'];
}): React.ReactElement | null {
  switch (block.kind) {
    case 'paragraph':
      // Auto-detect bare URLs and turn them into links. We intentionally
      // don't support inline formatting (bold, italic) — that's the
      // template's job, not the author's.
      return <p className="vja-block-paragraph">{linkifyText(block.text)}</p>;

    case 'callout': {
      const tone = block.tone;
      const Icon =
        tone === 'safety'
          ? ShieldAlert
          : tone === 'warning'
            ? AlertTriangle
            : tone === 'tip'
              ? Lightbulb
              : Info;
      return (
        <aside className={`vja-block-callout vja-callout-${tone}`}>
          <span className="vja-callout-icon" aria-hidden>
            <Icon size={18} strokeWidth={2} />
          </span>
          <div className="vja-callout-body">
            {block.title && <p className="vja-callout-title">{block.title}</p>}
            <p className="vja-callout-text">{linkifyText(block.text)}</p>
          </div>
        </aside>
      );
    }

    case 'bullet_list':
      return (
        <ul className="vja-block-list">
          {block.items.map((it, i) => (
            <li key={i}>{linkifyText(it)}</li>
          ))}
        </ul>
      );

    case 'numbered_list':
      return (
        <ol className="vja-block-list vja-block-list-numbered">
          {block.items.map((it, i) => (
            <li key={i}>{linkifyText(it)}</li>
          ))}
        </ol>
      );

    case 'key_value':
      return (
        <table className="vja-block-kv">
          <thead>
            <tr>
              <th>{block.columns[0]}</th>
              <th>{block.columns[1]}</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                <td>{row[0]}</td>
                <td>{row[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );

    case 'photo_inline': {
      const m = media.find((mm) => mm.storageKey === block.storageKey);
      if (!m || m.kind !== 'image' || !m.url) return null;
      const caption = block.caption ?? m.caption ?? null;
      return (
        <figure className="vja-block-photo">
          <FallbackImage
            src={m.url}
            alt={caption ?? 'Step photo'}
            label={caption ?? 'Photo unavailable'}
          />
          {caption && <figcaption>{caption}</figcaption>}
        </figure>
      );
    }
  }
}

// Image with a graceful fallback when load fails (404, CDN hiccup,
// permissions, etc.). Replaces the broken image icon with a labeled
// placeholder so a flaky network doesn't strand a tech mid-procedure.
function FallbackImage({
  src,
  alt,
  label,
}: {
  src: string;
  alt: string;
  label: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="vja-media-fallback" role="img" aria-label={alt}>
        <span aria-hidden>📷</span>
        <span>{label}</span>
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

// Video sibling of FallbackImage. <video onError> fires for codec /
// network / 404 failures; we swap to the same placeholder pattern.
function FallbackVideo({ src, label }: { src: string; label: string }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="vja-media-fallback" role="img" aria-label={label}>
        <span aria-hidden>🎞️</span>
        <span>{label}</span>
      </div>
    );
  }
  return <video src={src} controls preload="metadata" onError={() => setFailed(true)} />;
}

// Lightweight linkify — detects http(s):// URLs in text and wraps them
// in <a>. Avoids pulling in a markdown parser for plain prose; the
// authoring surface only allows bare URLs anyway (no markdown link syntax).
function linkifyText(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={m[1]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>,
    );
    last = m.index + m[1]!.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

// Small labeled chip list used three times in the intro's Required
// Tools subsection (Common / Special / Consumables). Returns null when
// empty so the parent's three lists collapse cleanly.
function ToolBucketList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="vja-hero-intro-tool-group">
      <span className="vja-hero-intro-tool-group-label">{label}:</span>
      <div className="vja-hero-intro-tools">
        {items.map((t) => (
          <span key={t} className="vja-hero-intro-tool">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
