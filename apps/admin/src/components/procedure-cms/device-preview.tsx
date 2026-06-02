'use client';

// Device preview — renders the procedure as it lays out on a field device, in
// a phone or tablet frame, before publishing. Styled to match the PWA's
// published "virtual job aid" runner (apps/pwa .vja-* styles): a LIGHT theme —
// a raised step card on a light surface, brand-colored section pill + step
// number, dark title (red when safety-critical), and tone-styled callouts.
// Reuses the editor's live edited step/section/block/media data so it reflects
// unpublished authoring exactly.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Info,
  Lightbulb,
  Pause,
  Play,
  ShieldAlert,
  Smartphone,
  Tablet,
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

interface OrderedStep {
  step: AdminProcedureStep;
  sectionLabel: string | null;
  sectionIndex: number; // 1-based position within its section
  sectionTotal: number;
}

/** Flatten steps into runner order: orphan steps (no section) first, then each
 *  section in ordering order with its steps. Mirrors the runtime ordering. */
function orderSteps(
  steps: AdminProcedureStep[],
  sections: AdminProcedureSection[],
): OrderedStep[] {
  const byHint = (a: { orderingHint: number }, b: { orderingHint: number }) =>
    a.orderingHint - b.orderingHint;
  const out: OrderedStep[] = [];

  const orphans = steps.filter((s) => !s.sectionId).sort(byHint);
  for (const s of orphans) {
    out.push({ step: s, sectionLabel: null, sectionIndex: 0, sectionTotal: 0 });
  }
  for (const sec of [...sections].sort(byHint)) {
    const inSec = steps.filter((s) => s.sectionId === sec.id).sort(byHint);
    inSec.forEach((s, i) => {
      out.push({
        step: s,
        sectionLabel: sec.title,
        sectionIndex: i + 1,
        sectionTotal: inSec.length,
      });
    });
  }
  return out;
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
  const [index, setIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const ordered = useMemo(() => orderSteps(steps, sections), [steps, sections]);
  const total = ordered.length;
  const current = ordered[Math.min(index, Math.max(0, total - 1))];

  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setPlaying(false);
  }, [index]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, total - 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total, onClose]);

  function toggleAudio() {
    const a = audioRef.current;
    if (!a || !current?.step.audioUrl) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }

  const frame = FRAMES[device];

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
        {total === 0 ? (
          <p className="text-sm text-white/70">This procedure has no steps yet.</p>
        ) : (
          <div
            className="relative shrink-0 overflow-hidden rounded-[2.25rem] border-[10px] border-neutral-800 bg-neutral-800 shadow-2xl"
            style={{ width: frame.w, height: frame.h, maxHeight: 'calc(100vh - 8rem)' }}
          >
            {/* Screen — forced LIGHT (the admin runs dark by default; the
                published runner is light). data-theme='light' re-applies the
                light palette to this subtree so every token resolves correctly. */}
            <div data-theme="light" className="flex h-full flex-col bg-surface text-ink-primary">
              {/* Topbar: doc title + segmented progress (.vja-topbar / .vja-progress). */}
              <div className="shrink-0 border-b border-line/60 px-4 pb-3 pt-4">
                <p className="truncate text-[15px] font-semibold leading-tight text-ink-primary">
                  {title}
                </p>
                <div className="mt-2.5 flex gap-1">
                  {ordered.map((_, i) => (
                    <span
                      key={i}
                      className={[
                        'h-1 flex-1 rounded-full transition-colors',
                        i < index ? 'bg-accent/50' : i === index ? 'bg-accent' : 'bg-line',
                      ].join(' ')}
                    />
                  ))}
                </div>
              </div>

              {/* Main — light surface, raised step card (.vja-main / .vja-step). */}
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {current && <StepCardView ordered={current} />}
              </div>

              {/* Footer nav. */}
              <div className="shrink-0 border-t border-line bg-surface px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIndex((i) => Math.max(i - 1, 0))}
                    disabled={index === 0}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-elevated text-ink-primary transition hover:bg-line disabled:opacity-30"
                    aria-label="Previous step"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  {current?.step.audioUrl ? (
                    <button
                      type="button"
                      onClick={toggleAudio}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-accent/90"
                    >
                      {playing ? <Pause size={16} /> : <Play size={16} />}
                      {playing ? 'Pause' : 'Play voiceover'}
                    </button>
                  ) : (
                    <div className="flex-1 text-center text-[11px] text-ink-tertiary">
                      No voiceover on this step
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setIndex((i) => Math.min(i + 1, total - 1))}
                    disabled={index >= total - 1}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-elevated text-ink-primary transition hover:bg-line disabled:opacity-30"
                    aria-label="Next step"
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <audio
        ref={audioRef}
        src={current?.step.audioUrl ?? undefined}
        onEnded={() => setPlaying(false)}
        className="hidden"
      />
    </div>
  );
}

function StepCardView({ ordered }: { ordered: OrderedStep }) {
  const { step, sectionLabel, sectionIndex, sectionTotal } = ordered;
  const images = (step.media ?? []).filter((m) => m.kind === 'image');
  const inlineKeys = new Set(
    (step.blocks ?? [])
      .filter((b): b is Extract<StepBlock, { kind: 'photo_inline' }> => b.kind === 'photo_inline')
      .map((b) => b.storageKey),
  );
  const galleryImages = images.filter((m) => !inlineKeys.has(m.storageKey));

  return (
    <article
      className={[
        'mx-auto flex max-w-[720px] flex-col gap-4 rounded-[14px] border bg-surface-raised p-[22px] shadow-sm',
        step.safetyCritical ? 'border-signal-fault/30' : 'border-line',
      ].join(' ')}
    >
      {/* Header: section pill · step number · safety pill */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {sectionLabel && (
          <span className="inline-flex max-w-full items-center truncate rounded-full border border-accent/35 bg-accent/10 px-2.5 py-[3px] text-[11px] font-bold uppercase tracking-[0.08em] text-accent">
            {sectionLabel}
          </span>
        )}
        {sectionTotal > 0 && (
          <span className="font-mono text-2xl font-bold leading-none tracking-tight text-accent">
            {String(sectionIndex).padStart(2, '0')}
            <span className="text-base font-medium text-ink-tertiary">
              {' / '}
              {String(sectionTotal).padStart(2, '0')}
            </span>
          </span>
        )}
        {step.safetyCritical && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-signal-fault/40 bg-signal-fault/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-signal-fault">
            <ShieldAlert size={12} strokeWidth={2} /> Safety-critical
          </span>
        )}
      </div>

      {/* Title */}
      <h1
        className={[
          'text-[27px] font-bold leading-[1.15] tracking-tight',
          step.safetyCritical ? 'text-signal-fault' : 'text-ink-primary',
        ].join(' ')}
      >
        {step.title}
      </h1>

      {/* Blocks */}
      {(step.blocks ?? []).length > 0 && (
        <div className="flex flex-col gap-3.5">
          {step.blocks.map((b, i) => (
            <BlockView key={i} block={b} images={images} />
          ))}
        </div>
      )}

      {/* Trailing media gallery — images not already shown inline. */}
      {galleryImages.length > 0 && (
        <div className="grid grid-cols-1 gap-3">
          {galleryImages.map((m) => (
            <figure key={m.storageKey} className="overflow-hidden rounded-[10px] bg-surface-inset">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url ?? ''} alt={m.caption ?? step.title} className="w-full object-contain" />
              {m.caption && (
                <figcaption className="px-3 py-1.5 text-xs text-ink-tertiary">{m.caption}</figcaption>
              )}
            </figure>
          ))}
        </div>
      )}
    </article>
  );
}

function BlockView({ block, images }: { block: StepBlock; images: AdminStepMedia[] }) {
  switch (block.kind) {
    case 'paragraph':
      return <p className="text-[17px] leading-[1.55] text-ink-secondary">{block.text}</p>;
    case 'callout':
      return <CalloutView block={block} />;
    case 'bullet_list':
      return (
        <ul className="flex list-disc flex-col gap-1 pl-[22px] text-[16px] leading-[1.6] text-ink-primary">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case 'numbered_list':
      return (
        <ol className="flex list-decimal flex-col gap-1 pl-[22px] text-[16px] leading-[1.6] text-ink-primary">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case 'key_value':
      return (
        <div className="overflow-hidden rounded-[10px] border border-line text-[15px]">
          <table className="w-full border-separate border-spacing-0">
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  <td className="border-b border-line bg-surface-elevated px-3 py-1.5 font-medium text-ink-secondary">
                    {row[0]}
                  </td>
                  <td className="border-b border-line px-3 py-1.5 text-ink-primary">{row[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'photo_inline': {
      const media = images.find((m) => m.storageKey === block.storageKey);
      if (!media?.url) return null;
      const caption = block.caption ?? media.caption ?? null;
      return (
        <figure className="overflow-hidden rounded-[10px] border border-line">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.url} alt={caption ?? ''} className="w-full object-contain" />
          {caption && (
            <figcaption className="bg-surface-elevated px-3 py-1.5 text-xs text-ink-tertiary">
              {caption}
            </figcaption>
          )}
        </figure>
      );
    }
    default:
      return null;
  }
}

function CalloutView({ block }: { block: Extract<StepBlock, { kind: 'callout' }> }) {
  const tone = block.tone;
  const styles: Record<
    typeof tone,
    { box: string; icon: React.ReactNode; title: string }
  > = {
    safety: {
      box: 'border-signal-fault/50 bg-signal-fault/[0.06]',
      icon: <ShieldAlert size={18} className="text-signal-fault" />,
      title: 'text-signal-fault',
    },
    warning: {
      box: 'border-signal-warn/50 bg-signal-warn/[0.07]',
      icon: <AlertTriangle size={18} className="text-signal-warn" />,
      title: 'text-signal-warn',
    },
    tip: {
      box: 'border-signal-info/50 bg-signal-info/[0.06]',
      icon: <Lightbulb size={18} className="text-signal-info" />,
      title: 'text-signal-info',
    },
    note: {
      box: 'border-line-strong bg-surface-elevated',
      icon: <Info size={18} className="text-ink-secondary" />,
      title: 'text-ink-secondary',
    },
  };
  const s = styles[tone];
  return (
    <aside className={`flex gap-3 rounded-[10px] border px-3.5 py-3 ${s.box}`}>
      <span className="shrink-0 pt-0.5">{s.icon}</span>
      <div className="min-w-0 flex-1">
        {block.title && (
          <p className={`mb-1 text-[13px] font-bold uppercase tracking-[0.06em] ${s.title}`}>
            {block.title}
          </p>
        )}
        <p className="text-[16px] leading-[1.5] text-ink-primary">{block.text}</p>
      </div>
    </aside>
  );
}
