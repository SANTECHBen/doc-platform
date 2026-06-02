'use client';

// Device preview — renders the procedure using the published runner's EXACT
// markup + CSS (copied verbatim into ./vja-preview.css from the PWA's
// virtual-job-aid), wrapped in a phone/tablet device frame. This is a literal
// preview: same class structure, same styles, same fonts (both apps load IBM
// Plex), so it matches the published output. The admin's in-memory step data is
// mapped to the same resolved shape the runner consumes.
//
// NOTE: this duplicates the runner's render. Stage 2 replaces both this and the
// PWA's copy with a single shared package so they can never drift.

import './vja-preview.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  Lightbulb,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Tablet,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type {
  AdminProcedureSection,
  AdminProcedureStep,
  AdminStepMedia,
  StepBlock,
} from '@/lib/api';

type DeviceKind = 'phone' | 'tablet';
const FRAMES: Record<DeviceKind, { w: number; h: number; label: string }> = {
  phone: { w: 390, h: 800, label: 'Phone' },
  tablet: { w: 760, h: 1000, label: 'Tablet' },
};
const DEFAULT_PHASE_COLOR = '#2563EB';

// Full light palette, applied to the screen subtree so the runner's CSS vars
// resolve light (the admin runs dark). data-theme='light' is set too as a
// backstop; the inline vars guarantee it regardless of CSS cascade.
const LIGHT_VARS = {
  '--surface-base': '245 246 248',
  '--surface-raised': '255 255 255',
  '--surface-elevated': '249 250 251',
  '--surface-inset': '240 242 246',
  '--line-subtle': '234 237 242',
  '--line': '221 226 233',
  '--line-strong': '189 197 209',
  '--ink-primary': '14 18 23',
  '--ink-secondary': '74 85 96',
  '--ink-tertiary': '128 138 150',
  '--ink-brand': '29 96 180',
  '--brand': '37 108 211',
  '--brand-strong': '29 88 178',
  '--signal-ok': '31 133 83',
  '--signal-warn': '191 111 26',
  '--signal-fault': '176 43 61',
  '--signal-info': '37 108 211',
  '--signal-safety': '171 126 30',
  '--shadow-sm': '0 1px 2px rgba(14,18,23,0.05)',
  '--font-mono': "'IBM Plex Mono', ui-monospace, monospace",
} as React.CSSProperties;

interface ResolvedStep {
  step: AdminProcedureStep;
  sectionLabel: string | null;
  sectionStepIndex: number;
  sectionStepTotal: number;
  categoryColor: string | null;
}
interface Phase {
  key: string | null;
  label: string;
  color: string;
  start: number;
  end: number;
}

function resolveSteps(
  steps: AdminProcedureStep[],
  sections: AdminProcedureSection[],
): ResolvedStep[] {
  const byHint = (a: { orderingHint: number }, b: { orderingHint: number }) =>
    a.orderingHint - b.orderingHint;
  const ordered: { step: AdminProcedureStep; secId: string | null; label: string | null; color: string | null }[] = [];

  const orphans = steps.filter((s) => !s.sectionId).sort(byHint);
  for (const s of orphans) ordered.push({ step: s, secId: null, label: null, color: null });
  for (const sec of [...sections].sort(byHint)) {
    const inSec = steps.filter((s) => s.sectionId === sec.id).sort(byHint);
    for (const s of inSec) {
      ordered.push({ step: s, secId: sec.id, label: sec.title, color: sec.category?.color ?? null });
    }
  }

  const totals = new Map<string | null, number>();
  for (const o of ordered) totals.set(o.secId, (totals.get(o.secId) ?? 0) + 1);
  const idx = new Map<string | null, number>();
  return ordered.map((o) => {
    const next = (idx.get(o.secId) ?? 0) + 1;
    idx.set(o.secId, next);
    return {
      step: o.step,
      sectionLabel: o.label,
      sectionStepIndex: next,
      sectionStepTotal: totals.get(o.secId) ?? 1,
      categoryColor: o.color,
    };
  });
}

function buildPhases(resolved: ResolvedStep[]): Phase[] {
  if (resolved.every((r) => !r.sectionLabel)) return [];
  const phases: Phase[] = [];
  let i = 0;
  while (i < resolved.length) {
    const label = resolved[i]!.sectionLabel;
    const color = resolved[i]!.categoryColor ?? DEFAULT_PHASE_COLOR;
    let j = i + 1;
    while (j < resolved.length && resolved[j]!.sectionLabel === label) j += 1;
    phases.push({ key: label, label: label ?? 'Steps', color, start: i, end: j });
    i = j;
  }
  return phases;
}

export function DevicePreviewModal({
  title,
  steps,
  sections,
  onClose,
}: {
  title: string;
  steps: AdminProcedureStep[];
  sections: AdminProcedureSection[];
  onClose: () => void;
}) {
  const [device, setDevice] = useState<DeviceKind>('phone');
  const [stepIdx, setStepIdx] = useState(0);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const resolved = useMemo(() => resolveSteps(steps, sections), [steps, sections]);
  const phases = useMemo(() => buildPhases(resolved), [resolved]);
  const total = resolved.length;
  const idx = Math.min(stepIdx, Math.max(0, total - 1));
  const current = resolved[idx];
  const isLast = idx >= total - 1;

  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
  }, [idx]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setStepIdx((i) => Math.min(i + 1, total - 1));
      else if (e.key === 'ArrowLeft') setStepIdx((i) => Math.max(i - 1, 0));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total, onClose]);

  function replay() {
    const a = audioRef.current;
    if (!a || muted || !current?.step.audioUrl) return;
    a.currentTime = 0;
    void a.play().catch(() => {});
  }

  const frame = FRAMES[device];
  const activePhase = phases.find((p) => idx >= p.start && idx < p.end) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm">
      {/* Admin chrome toolbar (outside the device). */}
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5 text-white">
        <span className="text-sm font-semibold">Device preview</span>
        <span className="truncate text-xs text-white/60">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-white/20">
            {(['phone', 'tablet'] as DeviceKind[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDevice(d)}
                className={[
                  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition',
                  device === d ? 'bg-white text-neutral-900' : 'text-white/80 hover:bg-white/10',
                ].join(' ')}
              >
                {d === 'phone' ? <Smartphone size={14} /> : <Tablet size={14} />}
                {FRAMES[d].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-md p-1.5 text-white/80 transition hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-6">
        {total === 0 || !current ? (
          <p className="text-sm text-white/70">This procedure has no steps yet.</p>
        ) : (
          <div
            className="relative shrink-0 overflow-hidden rounded-[2.25rem] border-[10px] border-neutral-800 bg-neutral-800 shadow-2xl"
            style={{ width: frame.w, height: frame.h, maxHeight: 'calc(100vh - 8rem)' }}
          >
            {/* Screen — the runner's exact markup, forced light. */}
            <div
              data-theme="light"
              style={LIGHT_VARS}
              className="vja-preview-screen relative h-full w-full overflow-hidden"
            >
              <div className="vja-root" role="dialog" aria-label="Procedure preview">
                <header className="vja-topbar">
                  <div className="vja-topbar-meta">
                    <h2 className="vja-doc-title">{title}</h2>
                  </div>
                  <button
                    type="button"
                    className="vja-mute"
                    onClick={() => setMuted((m) => !m)}
                    aria-label={muted ? 'Unmute' : 'Mute'}
                  >
                    {muted ? <VolumeX size={18} strokeWidth={2} /> : <Volume2 size={18} strokeWidth={2} />}
                  </button>
                  <button type="button" className="vja-close" onClick={onClose} aria-label="Close">
                    <X size={18} strokeWidth={2} />
                  </button>
                </header>

                {phases.length > 0 ? (
                  <nav className="vja-phases" aria-label="Procedure phases">
                    {phases.map((p) => {
                      const span = p.end - p.start;
                      const done = Math.max(0, Math.min(span, idx - p.start));
                      const isActive = idx >= p.start && idx < p.end;
                      const pct = span > 0 ? Math.round((done / span) * 100) : 0;
                      return (
                        <button
                          type="button"
                          key={p.key ?? '__orphans__'}
                          onClick={() => setStepIdx(p.start)}
                          className="vja-phase"
                          data-active={isActive ? 'true' : 'false'}
                        >
                          <span className="vja-phase-label" style={isActive ? { color: p.color } : undefined}>
                            {p.label}
                          </span>
                          <span className="vja-phase-bar" aria-hidden>
                            <span
                              className="vja-phase-fill"
                              style={{ width: `${pct}%`, backgroundColor: p.color, opacity: isActive ? 1 : 0.6 }}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </nav>
                ) : (
                  <div className="vja-progress" aria-hidden>
                    {resolved.map((_, i) => (
                      <span
                        key={i}
                        className="vja-progress-seg"
                        data-state={i < idx ? 'done' : i === idx ? 'active' : 'pending'}
                      />
                    ))}
                  </div>
                )}

                <div className="vja-main">
                  <StepArticle resolved={current} phaseColor={activePhase?.color ?? null} />
                </div>

                <footer className="vja-controls">
                  <button
                    type="button"
                    className="vja-btn vja-btn-ghost"
                    onClick={() => setStepIdx((i) => Math.max(i - 1, 0))}
                    disabled={idx === 0}
                    aria-label="Previous step"
                  >
                    <ChevronLeft size={18} strokeWidth={2.25} />
                    <span>Back</span>
                  </button>
                  <button
                    type="button"
                    className="vja-btn vja-btn-secondary"
                    onClick={replay}
                    disabled={muted || !current.step.audioUrl}
                    aria-label="Replay step"
                    title="Replay this step"
                  >
                    <RefreshCw size={18} strokeWidth={2.25} />
                    <span>Replay</span>
                  </button>
                  <button
                    type="button"
                    className="vja-btn vja-btn-primary"
                    onClick={() => setStepIdx((i) => Math.min(i + 1, total - 1))}
                    aria-label={isLast ? 'Finish' : 'Next step'}
                  >
                    <span>{isLast ? 'Finish' : 'Next'}</span>
                    <ChevronRight size={18} strokeWidth={2.25} />
                  </button>
                </footer>
              </div>
            </div>
          </div>
        )}
      </div>

      <audio ref={audioRef} src={current?.step.audioUrl ?? undefined} className="hidden" />
    </div>
  );
}

function StepArticle({ resolved, phaseColor }: { resolved: ResolvedStep; phaseColor: string | null }) {
  const { step, sectionLabel, sectionStepIndex, sectionStepTotal } = resolved;
  const media = step.media ?? [];
  const inlineKeys = new Set(
    (step.blocks ?? [])
      .filter((b): b is Extract<StepBlock, { kind: 'photo_inline' }> => b.kind === 'photo_inline')
      .map((b) => b.storageKey),
  );
  const gallery = media.filter((m) => !inlineKeys.has(m.storageKey));

  return (
    <article className={`vja-step ${step.safetyCritical ? 'vja-step-safety' : ''}`} aria-live="polite">
      <div className="vja-step-header">
        {sectionLabel && (
          <span
            className="vja-section-label"
            style={
              phaseColor
                ? { color: phaseColor, borderColor: phaseColor, backgroundColor: `${phaseColor}1A` }
                : undefined
            }
          >
            {sectionLabel}
          </span>
        )}
        <span className="vja-step-num">
          {String(sectionStepIndex).padStart(2, '0')}
          <span className="vja-step-of"> / {String(sectionStepTotal).padStart(2, '0')}</span>
        </span>
        {step.safetyCritical && (
          <span className="vja-safety-pill">
            <ShieldAlert size={12} strokeWidth={2} />
            Safety-critical
          </span>
        )}
      </div>
      <h1 className="vja-step-title">{step.title}</h1>
      {(step.blocks ?? []).length > 0 && (
        <div className="vja-blocks">
          {step.blocks.map((b, i) => (
            <BlockRenderer key={i} block={b} media={media} />
          ))}
        </div>
      )}
      {gallery.length > 0 && (
        <ul className="vja-step-media">
          {gallery.map((m, i) => (
            <li key={`${m.storageKey}-${i}`}>
              {m.kind === 'image' ? (
                <FallbackImage src={m.url ?? ''} alt={m.caption ?? step.title} label={m.caption ?? 'Image unavailable'} />
              ) : null}
              {m.kind === 'image' && m.caption && <p className="vja-step-caption">{m.caption}</p>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function BlockRenderer({ block, media }: { block: StepBlock; media: AdminStepMedia[] }): React.ReactElement | null {
  switch (block.kind) {
    case 'paragraph':
      return <p className="vja-block-paragraph">{linkifyText(block.text)}</p>;
    case 'callout': {
      const tone = block.tone;
      const Icon = tone === 'safety' ? ShieldAlert : tone === 'warning' ? AlertTriangle : tone === 'tip' ? Lightbulb : Info;
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
          <FallbackImage src={m.url} alt={caption ?? 'Step photo'} label={caption ?? 'Photo unavailable'} />
          {caption && <figcaption>{caption}</figcaption>}
        </figure>
      );
    }
    default:
      return null;
  }
}

function FallbackImage({ src, alt, label }: { src: string; alt: string; label: string }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return (
      <div className="vja-media-fallback" role="img" aria-label={alt}>
        <span aria-hidden>📷</span>
        <span>{label}</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

// Bare-URL → link, matching the runner (no inline bold/italic — the template
// owns styling).
function linkifyText(text: string): React.ReactNode {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer">
        {p}
      </a>
    ) : (
      p
    ),
  );
}
