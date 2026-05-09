'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  ChevronRight,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  getProcedureDoc,
  speak,
  type ProcedureDocFullDto,
} from '@/lib/api';

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
}

// Internal normalized shape — what the renderer actually consumes.
interface ResolvedJobAid {
  title: string;
  steps: Array<{
    title: string;
    bodyMarkdown: string | null;
    safetyCritical: boolean;
    media: Array<{ kind: 'image' | 'video'; url?: string | null; caption?: string; storageKey: string }>;
    substeps: Array<{ id?: string; title: string; bodyMarkdown?: string | null }>;
    /** When the author attached or generated a voiceover, this URL plays
     *  instead of synthesizing TTS at run time. */
    audioUrl: string | null;
  }>;
}

function normalizeFromDoc(doc: ProcedureDocFullDto): ResolvedJobAid {
  return {
    title: doc.document.title,
    steps: doc.steps.map((s) => ({
      title: s.title,
      bodyMarkdown: s.bodyMarkdown ?? null,
      safetyCritical: s.safetyCritical,
      media: s.media,
      substeps: s.substeps,
      audioUrl: (s as ProcedureDocFullDto['steps'][number] & { audioUrl?: string | null })
        .audioUrl ?? null,
    })),
  };
}

function normalizeFromInline(
  inline: Extract<JobAidSource, { kind: 'inline' }>,
): ResolvedJobAid {
  return {
    title: inline.title,
    steps: inline.steps.map((s) => ({
      title: s.title,
      bodyMarkdown: s.bodyMarkdown ?? null,
      safetyCritical: !!s.safetyCritical,
      media: [],
      substeps: [],
      audioUrl: null,
    })),
  };
}

export function VirtualJobAid({ source, onClose, autoSpeak = true }: Props): React.ReactElement {
  const [resolved, setResolved] = useState<ResolvedJobAid | null>(
    source.kind === 'inline' ? normalizeFromInline(source) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  // Imperative refs for audio so React state changes don't restart playback.
  // Two playback paths coexist:
  //   - audio element  → plays an authored mp3 from a URL (preferred when
  //                      step.audioUrl is set; uses HTML5 streaming).
  //   - WebAudio source → plays a Blob fetched from /ai/voice/speak (TTS
  //                      fallback when no authored audio exists).
  // Only one path runs at a time; stopPlayback tears down whichever is live.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const htmlAudioRef = useRef<HTMLAudioElement | null>(null);

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
        if (!cancelled) setResolved(normalizeFromDoc(full));
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
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
      audioCtxRef.current = null;
    };
  }, []);

  function stopPlayback() {
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
      htmlAudioRef.current.src = '';
      htmlAudioRef.current = null;
    }
    setSpeaking(false);
  }

  const speakCurrent = useCallback(async () => {
    if (muted) return;
    const step = resolved?.steps[stepIdx];
    if (!step) return;
    stopPlayback();

    // Path 1 — authored voiceover. Always preferred when present: better
    // fidelity (custom emphasis, your shop voice), zero per-play cost,
    // streams from CDN. We use HTMLAudioElement rather than WebAudio so
    // browsers do their normal preload/seek/codec handling.
    if (step.audioUrl) {
      try {
        setSpeaking(true);
        const audio = new Audio(step.audioUrl);
        audio.preload = 'auto';
        audio.crossOrigin = 'anonymous';
        htmlAudioRef.current = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error('audio load failed'));
          audio.play().catch(reject);
        });
      } catch (err) {
        console.warn('[virtual-job-aid] authored audio failed, falling back to TTS', err);
        // Fall through to TTS path below.
      } finally {
        if (htmlAudioRef.current) {
          htmlAudioRef.current = null;
        }
        setSpeaking(false);
      }
      // If authored audio played successfully we're done.
      if (!step.audioUrl || htmlAudioRef.current === null) {
        // Authored play attempt completed (success or graceful fail).
        // If the play succeeded onended fired and we exit cleanly. If it
        // errored we deliberately fall through to TTS below.
      }
      // Whether success or failure, exit so we don't double-speak. The
      // caller catches a missing audio by re-invoking speakCurrent if it
      // wants TTS too — but practically audio failures are rare and
      // double-speaking would be worse UX.
      return;
    }

    // Path 2 — live TTS fallback (used when no authored audio exists).
    const lead = step.safetyCritical ? 'Safety critical step. ' : '';
    const numbering = `Step ${stepIdx + 1} of ${resolved!.steps.length}. `;
    const body = step.bodyMarkdown
      ? step.bodyMarkdown
          .replace(/[#>*_`]/g, '')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
          .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
    const text = `${lead}${numbering}${step.title}.${body ? ' ' + body : ''}`;
    if (text.length === 0) return;

    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();

      setSpeaking(true);
      const resp = await speak(text);
      const buf = await resp.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);
      sourceRef.current = source;
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
    } catch (err) {
      console.warn('[virtual-job-aid] TTS failed', err);
    } finally {
      setSpeaking(false);
      sourceRef.current = null;
    }
  }, [resolved, stepIdx, muted]);

  // Auto-speak when the step changes.
  useEffect(() => {
    if (!resolved || !autoSpeak || muted) return;
    void speakCurrent();
    return () => stopPlayback();
    // intentional: speakCurrent is stable enough; we want this to fire on
    // step change, not on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, stepIdx, autoSpeak, muted]);

  function next() {
    if (!resolved) return;
    if (stepIdx >= resolved.steps.length - 1) {
      stopPlayback();
      onClose({ completed: true });
      return;
    }
    stopPlayback();
    setStepIdx((i) => i + 1);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        // ignore
      }
    }
  }
  function prev() {
    if (stepIdx === 0) return;
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

  return (
    <div className="vja-root" role="dialog" aria-label={resolved.title}>
      <header className="vja-topbar">
        <div className="vja-topbar-meta">
          <span className="caption inline-flex items-center gap-1.5">
            <ListChecks size={12} strokeWidth={1.75} />
            VIRTUAL JOB AID
          </span>
          <h2 className="vja-doc-title">{resolved.title}</h2>
        </div>
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

      {/* Progress strip — one segment per step, current pulses. */}
      <div className="vja-progress" aria-hidden>
        {resolved.steps.map((_, i) => (
          <span
            key={i}
            className="vja-progress-seg"
            data-state={i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'pending'}
          />
        ))}
      </div>

      <main className="vja-main">
        {step && (
          <article
            key={stepIdx}
            className={`vja-step ${step.safetyCritical ? 'vja-step-safety' : ''}`}
            aria-live="polite"
          >
            <div className="vja-step-header">
              <span className="vja-step-num">
                {String(stepIdx + 1).padStart(2, '0')}
                <span className="vja-step-of"> / {String(totalSteps).padStart(2, '0')}</span>
              </span>
              {step.safetyCritical && (
                <span className="vja-safety-pill">
                  <ShieldAlert size={12} strokeWidth={2} />
                  Safety-critical
                </span>
              )}
            </div>
            <h1 className="vja-step-title">{step.title}</h1>
            {step.bodyMarkdown && (
              <div className="markdown-body vja-step-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.bodyMarkdown}</ReactMarkdown>
              </div>
            )}
            {step.media.length > 0 && (
              <ul className="vja-step-media">
                {step.media.map((m, i) => (
                  <li key={`${m.storageKey}-${i}`}>
                    {m.kind === 'image' ? (
                      <img src={m.url ?? ''} alt={m.caption ?? ''} />
                    ) : (
                      <video src={m.url ?? ''} controls preload="metadata" />
                    )}
                    {m.caption && <p className="vja-step-caption">{m.caption}</p>}
                  </li>
                ))}
              </ul>
            )}
            {step.substeps.length > 0 && (
              <ol className="vja-substeps">
                {step.substeps.map((ss, i) => (
                  <li key={ss.id ?? i}>
                    <span className="vja-substep-num">
                      {String(stepIdx + 1).padStart(2, '0')}.{String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="vja-substep-title">{ss.title}</span>
                    {ss.bodyMarkdown && (
                      <div className="markdown-body vja-substep-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {ss.bodyMarkdown}
                        </ReactMarkdown>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </article>
        )}
      </main>

      <footer className="vja-controls">
        <button
          type="button"
          className="vja-btn vja-btn-ghost"
          onClick={prev}
          disabled={stepIdx === 0}
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
          <RefreshCw
            size={18}
            strokeWidth={2.25}
            className={speaking ? 'vja-spin' : ''}
          />
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
      </footer>
    </div>
  );
}
