'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  Lightbulb,
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
  type StepBlock,
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
    blocks: StepBlock[];
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
    steps: doc.steps.map((s) => {
      const augmented = s as ProcedureDocFullDto['steps'][number] & {
        audioUrl?: string | null;
        blocks?: StepBlock[];
      };
      return {
        title: s.title,
        bodyMarkdown: s.bodyMarkdown ?? null,
        blocks: augmented.blocks ?? [],
        safetyCritical: s.safetyCritical,
        media: s.media,
        substeps: s.substeps,
        audioUrl: augmented.audioUrl ?? null,
      };
    }),
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
      blocks: [],
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
      // removeAttribute + load() is the spec-correct way to fully detach
      // the source — `src = ''` can leave the element in a "loading"
      // state on some browsers where playback resumes after a delay.
      htmlAudioRef.current.removeAttribute('src');
      try {
        htmlAudioRef.current.load();
      } catch {
        // ignore
      }
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
    // streams from CDN. We use HTMLAudioElement rather than WebAudio so
    // browsers do their normal preload/seek/codec handling.
    if (step.audioUrl) {
      let audio: HTMLAudioElement | null = null;
      try {
        setSpeaking(true);
        audio = new Audio(step.audioUrl);
        audio.preload = 'auto';
        audio.crossOrigin = 'anonymous';
        if (isStale()) {
          // Superseded between the muted-check and now (extremely unlikely,
          // but defensive). Don't even start playback.
          return;
        }
        htmlAudioRef.current = audio;
        await new Promise<void>((resolve, reject) => {
          audio!.onended = () => resolve();
          audio!.onerror = () => reject(new Error('audio load failed'));
          audio!.play().catch(reject);
        });
      } catch (err) {
        console.warn('[virtual-job-aid] authored audio failed, falling back to TTS', err);
        // Fall through to TTS path below.
      } finally {
        if (htmlAudioRef.current === audio) {
          htmlAudioRef.current = null;
        }
        setSpeaking(false);
      }
      return;
    }

    // Path 2 — live TTS fallback (used when no authored audio exists).
    // Prefer typed blocks for the spoken script; structured text reads
    // better than paraphrased markdown. Fall back to bodyMarkdown for
    // legacy procedures.
    const lead = step.safetyCritical ? 'Safety critical step. ' : '';
    const numbering = `Step ${stepIdx + 1} of ${resolved!.steps.length}. `;
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
            {/* Typed blocks take precedence — the template renders each
                kind with consistent visual style. Legacy procedures fall
                back to their bodyMarkdown until they're migrated. */}
            {step.blocks.length > 0 ? (
              <div className="vja-blocks">
                {step.blocks.map((b, i) => (
                  <BlockRenderer
                    key={i}
                    block={b}
                    media={step.media}
                  />
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
              const galleryMedia = step.media.filter(
                (m) => !inlineKeys.has(m.storageKey),
              );
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
                      ) : (
                        <FallbackVideo
                          src={m.url ?? ''}
                          label={m.caption ?? 'Video unavailable'}
                        />
                      )}
                      {m.caption && <p className="vja-step-caption">{m.caption}</p>}
                    </li>
                  ))}
                </ul>
              );
            })()}
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
  media: Array<{ kind: 'image' | 'video'; url?: string | null; caption?: string; storageKey: string }>;
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
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// Video sibling of FallbackImage. <video onError> fires for codec /
// network / 404 failures; we swap to the same placeholder pattern.
function FallbackVideo({
  src,
  label,
}: {
  src: string;
  label: string;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="vja-media-fallback" role="img" aria-label={label}>
        <span aria-hidden>🎞️</span>
        <span>{label}</span>
      </div>
    );
  }
  return (
    <video
      src={src}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
    />
  );
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
