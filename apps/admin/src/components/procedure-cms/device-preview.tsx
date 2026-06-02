'use client';

// Device preview — renders the procedure with the published runner's exact
// markup + the shared @platform/ui job-aid renderer/CSS, in a phone/tablet
// device frame. Two surfaces share one frame component (JobAidDeviceFrame):
//   - DevicePreviewModal: full-screen modal (the toolbar "Preview" button).
//   - LiveDevicePreview: a sticky side pane in the Step Editor that auto-updates
//     as you edit and stays synced to the step you're working on.

import '@platform/ui/job-aid.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { JobAidBlockRenderer, JobAidFallbackImage } from '@platform/ui';
import type { AdminProcedureSection, AdminProcedureStep } from '@/lib/api';

interface DeviceSpec {
  id: string;
  name: string;
  category: 'phone' | 'tablet';
  w: number; // logical CSS viewport width (like browser device emulation)
  h: number;
}

// Logical (CSS) viewport sizes — the dimensions browser devtools emulate.
const DEVICES: DeviceSpec[] = [
  { id: 'iphone-se', name: 'iPhone SE', category: 'phone', w: 375, h: 667 },
  { id: 'iphone-13-mini', name: 'iPhone 13 mini', category: 'phone', w: 375, h: 812 },
  { id: 'iphone-15', name: 'iPhone 14 / 15', category: 'phone', w: 393, h: 852 },
  { id: 'iphone-15-plus', name: 'iPhone 15 Plus', category: 'phone', w: 428, h: 926 },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', category: 'phone', w: 430, h: 932 },
  { id: 'pixel-8', name: 'Pixel 8', category: 'phone', w: 412, h: 915 },
  { id: 'galaxy-s23', name: 'Galaxy S23', category: 'phone', w: 360, h: 780 },
  { id: 'galaxy-s23-ultra', name: 'Galaxy S23 Ultra', category: 'phone', w: 384, h: 824 },
  { id: 'ipad-mini', name: 'iPad mini', category: 'tablet', w: 768, h: 1024 },
  { id: 'ipad-air', name: 'iPad Air', category: 'tablet', w: 820, h: 1180 },
  { id: 'ipad-pro-11', name: 'iPad Pro 11"', category: 'tablet', w: 834, h: 1194 },
  { id: 'ipad-pro-13', name: 'iPad Pro 12.9"', category: 'tablet', w: 1024, h: 1366 },
];
const PHONES = DEVICES.filter((d) => d.category === 'phone');
const DEFAULT_DEVICE = DEVICES.find((d) => d.id === 'iphone-15')!;
const BEZEL = 10; // device-frame border px per side
const DEFAULT_PHASE_COLOR = '#2563EB';

function deviceById(id: string): DeviceSpec {
  return DEVICES.find((d) => d.id === id) ?? DEFAULT_DEVICE;
}

// Light palette, forced on the screen subtree (the admin runs dark).
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

export function resolveSteps(
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
  const idxMap = new Map<string | null, number>();
  return ordered.map((o) => {
    const next = (idxMap.get(o.secId) ?? 0) + 1;
    idxMap.set(o.secId, next);
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

// ---------------------------------------------------------------------------
// JobAidDeviceFrame — the device bezel + screen + footer. Controlled index.
// Scales down to fit `maxWidth` (for the side pane); manages its own audio.
// ---------------------------------------------------------------------------

function JobAidDeviceFrame({
  title,
  steps,
  sections,
  spec,
  index,
  onIndexChange,
  fill,
}: {
  title: string;
  steps: AdminProcedureStep[];
  sections: AdminProcedureSection[];
  spec: DeviceSpec;
  index: number;
  onIndexChange: (next: number) => void;
  /** Fill the parent's height (live side pane) instead of a fixed device
   *  height (modal). The screen scrolls internally either way. */
  fill?: boolean;
}) {
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const resolved = useMemo(() => resolveSteps(steps, sections), [steps, sections]);
  const phases = useMemo(() => buildPhases(resolved), [resolved]);
  const total = resolved.length;
  const idx = Math.min(Math.max(index, 0), Math.max(0, total - 1));
  const current = resolved[idx];
  const isLast = idx >= total - 1;

  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
  }, [idx]);

  function replay() {
    const a = audioRef.current;
    if (!a || muted || !current?.step.audioUrl) return;
    a.currentTime = 0;
    void a.play().catch(() => {});
  }

  const activePhase = phases.find((p) => idx >= p.start && idx < p.end) ?? null;

  if (total === 0 || !current) {
    return <p className="text-sm text-ink-tertiary">This procedure has no steps yet.</p>;
  }

  // Bezel border eats into the box; add it so the screen (viewport) is exactly
  // spec.w × spec.h — what browser device emulation reports.
  const bw = spec.w + BEZEL * 2;
  const bh = spec.h + BEZEL * 2;

  return (
    <div
      className={fill ? 'flex min-h-0 flex-col' : ''}
      style={fill ? { width: bw } : undefined}
    >
      <div
        className="relative overflow-hidden rounded-[2.25rem] border-[10px] border-neutral-800 bg-neutral-800 shadow-2xl"
        style={
          fill
            ? { width: bw, flex: '1 1 0%', minHeight: 0 }
            : { width: bw, height: bh, maxHeight: 'calc(100dvh - 7rem)' }
        }
      >
        <div data-theme="light" style={LIGHT_VARS} className="vja-preview-screen relative h-full w-full overflow-hidden">
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
                      onClick={() => onIndexChange(p.start)}
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
                onClick={() => onIndexChange(Math.max(idx - 1, 0))}
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
                onClick={() => onIndexChange(Math.min(idx + 1, total - 1))}
                aria-label={isLast ? 'Finish' : 'Next step'}
              >
                <span>{isLast ? 'Finish' : 'Next'}</span>
                <ChevronRight size={18} strokeWidth={2.25} />
              </button>
            </footer>
          </div>
        </div>
      </div>
      <audio ref={audioRef} src={current.step.audioUrl ?? undefined} className="hidden" />
    </div>
  );
}

function DeviceSelect({
  devices,
  value,
  onChange,
  dark,
}: {
  devices: DeviceSpec[];
  value: string;
  onChange: (id: string) => void;
  dark?: boolean;
}) {
  const cats: Array<{ key: 'phone' | 'tablet'; label: string }> = [
    { key: 'phone', label: 'Phones' },
    { key: 'tablet', label: 'Tablets' },
  ];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Preview device"
      className={[
        'cursor-pointer rounded-md border px-2 py-1 text-xs font-medium outline-none transition',
        dark
          ? 'border-white/20 bg-white/10 text-white hover:bg-white/15 [&>optgroup]:text-neutral-900 [&>option]:text-neutral-900'
          : 'border-line bg-surface text-ink-primary hover:border-accent/40',
      ].join(' ')}
    >
      {cats.map((c) => {
        const items = devices.filter((d) => d.category === c.key);
        if (items.length === 0) return null;
        return (
          <optgroup key={c.key} label={c.label}>
            {items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.w}×{d.h}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Modal — the full-screen "Preview" button surface.
// ---------------------------------------------------------------------------

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
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE.id);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5 text-white">
        <span className="text-sm font-semibold">Device preview</span>
        <span className="truncate text-xs text-white/60">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          <DeviceSelect devices={DEVICES} value={deviceId} onChange={setDeviceId} dark />
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
      <div className="flex flex-1 items-center justify-center overflow-auto p-6">
        <JobAidDeviceFrame
          title={title}
          steps={steps}
          sections={sections}
          spec={deviceById(deviceId)}
          index={index}
          onIndexChange={setIndex}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live side pane — sticky in the Step Editor; auto-updates from edits and
// stays synced to the step being edited via currentStepId.
// ---------------------------------------------------------------------------

export function LiveDevicePreview({
  title,
  steps,
  sections,
  currentStepId,
  onCurrentStepIdChange,
}: {
  title: string;
  steps: AdminProcedureStep[];
  sections: AdminProcedureSection[];
  currentStepId: string | null;
  onCurrentStepIdChange: (id: string | null) => void;
}) {
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE.id);
  const ordered = useMemo(() => resolveSteps(steps, sections), [steps, sections]);
  const index = Math.max(0, ordered.findIndex((o) => o.step.id === currentStepId));

  return (
    <aside className="sticky top-[4.5rem] hidden h-[calc(100dvh-6rem)] flex-col gap-2 xl:flex">
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          Live preview
        </span>
        <DeviceSelect devices={PHONES} value={deviceId} onChange={setDeviceId} />
      </div>
      <div className="flex min-h-0 flex-1 justify-center">
        <JobAidDeviceFrame
          title={title}
          steps={steps}
          sections={sections}
          spec={deviceById(deviceId)}
          index={index}
          onIndexChange={(next) => onCurrentStepIdChange(ordered[next]?.step.id ?? null)}
          fill
        />
      </div>
    </aside>
  );
}

function StepArticle({ resolved, phaseColor }: { resolved: ResolvedStep; phaseColor: string | null }) {
  const { step, sectionLabel, sectionStepIndex, sectionStepTotal } = resolved;
  const media = step.media ?? [];
  const inlineKeys = new Set(
    (step.blocks ?? []).flatMap((b) => (b.kind === 'photo_inline' ? [b.storageKey] : [])),
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
            <JobAidBlockRenderer key={i} block={b} media={media} />
          ))}
        </div>
      )}
      {gallery.length > 0 && (
        <ul className="vja-step-media">
          {gallery.map((m, i) => (
            <li key={`${m.storageKey}-${i}`}>
              {m.kind === 'image' ? (
                <JobAidFallbackImage src={m.url ?? ''} alt={m.caption ?? step.title} label={m.caption ?? 'Image unavailable'} />
              ) : null}
              {m.kind === 'image' && m.caption && <p className="vja-step-caption">{m.caption}</p>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
