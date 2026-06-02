'use client';

// Device preview — renders the procedure as it lays out on a field device,
// in a phone or tablet frame, before publishing. It reuses the live edited
// step/section/block/media data the editor already holds, so it reflects
// unsaved-to-published authoring exactly. It is a faithful content re-render
// (titles, blocks, callouts, inline photos, section flow, voiceover playback),
// not the literal PWA component — that one is coupled to the PWA app.

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

  // Stop audio whenever the step changes.
  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setPlaying(false);
  }, [index]);

  // Keyboard nav: ← → to move, Esc to close.
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
      {/* Toolbar */}
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
            className="relative shrink-0 overflow-hidden rounded-[2.25rem] border-[10px] border-neutral-800 bg-white shadow-2xl"
            style={{
              width: frame.w,
              height: frame.h,
              maxHeight: 'calc(100vh - 8rem)',
            }}
          >
            {/* Screen */}
            <div className="flex h-full flex-col bg-[#0f1115] text-white">
              {/* Status / progress header */}
              <div className="shrink-0 px-5 pt-5">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-white/50">
                  <span className="truncate">{current?.sectionLabel ?? title}</span>
                  <span className="shrink-0 font-mono">
                    {index + 1} / {total}
                  </span>
                </div>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${((index + 1) / total) * 100}%` }}
                  />
                </div>
              </div>

              {/* Step body (scrollable) */}
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {current && <StepView step={current.step} />}
              </div>

              {/* Footer nav */}
              <div className="shrink-0 border-t border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIndex((i) => Math.max(i - 1, 0))}
                    disabled={index === 0}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
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
                    <div className="flex-1 text-center text-[11px] text-white/40">
                      No voiceover on this step
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setIndex((i) => Math.min(i + 1, total - 1))}
                    disabled={index >= total - 1}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
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

      {/* Shared audio element for the current step. */}
      <audio
        ref={audioRef}
        src={current?.step.audioUrl ?? undefined}
        onEnded={() => setPlaying(false)}
        className="hidden"
      />
    </div>
  );
}

function StepView({ step }: { step: AdminProcedureStep }) {
  const images = (step.media ?? []).filter((m) => m.kind === 'image');
  return (
    <div className="flex flex-col gap-4">
      {step.safetyCritical && (
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-red-300">
          <ShieldAlert size={12} /> Safety critical
        </span>
      )}
      <h2 className="text-xl font-semibold leading-snug">{step.title}</h2>
      {(step.blocks ?? []).map((b, i) => (
        <BlockView key={i} block={b} images={images} />
      ))}
    </div>
  );
}

function BlockView({ block, images }: { block: StepBlock; images: AdminStepMedia[] }) {
  switch (block.kind) {
    case 'paragraph':
      return <p className="text-[15px] leading-relaxed text-white/85">{block.text}</p>;
    case 'callout':
      return <CalloutView block={block} />;
    case 'bullet_list':
      return (
        <ul className="ml-5 list-disc space-y-1 text-[15px] text-white/85">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case 'numbered_list':
      return (
        <ol className="ml-5 list-decimal space-y-1 text-[15px] text-white/85">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      );
    case 'key_value':
      return (
        <div className="overflow-hidden rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-white/5 last:border-0">
                  <td className="bg-white/5 px-3 py-1.5 font-medium text-white/70">{row[0]}</td>
                  <td className="px-3 py-1.5 text-white/90">{row[1]}</td>
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
        <figure className="overflow-hidden rounded-lg border border-white/10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.url} alt={caption ?? ''} className="w-full object-contain" />
          {caption && (
            <figcaption className="bg-white/5 px-3 py-1.5 text-xs text-white/60">{caption}</figcaption>
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
  const styles: Record<typeof tone, { box: string; icon: React.ReactNode }> = {
    safety: {
      box: 'border-red-500/40 bg-red-500/10 text-red-200',
      icon: <ShieldAlert size={16} className="text-red-300" />,
    },
    warning: {
      box: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
      icon: <AlertTriangle size={16} className="text-amber-300" />,
    },
    tip: {
      box: 'border-sky-500/40 bg-sky-500/10 text-sky-100',
      icon: <Lightbulb size={16} className="text-sky-300" />,
    },
    note: {
      box: 'border-white/15 bg-white/5 text-white/80',
      icon: <Info size={16} className="text-white/60" />,
    },
  };
  const s = styles[tone];
  return (
    <aside className={`flex gap-2.5 rounded-lg border px-3 py-2.5 ${s.box}`}>
      <span className="mt-0.5 shrink-0">{s.icon}</span>
      <div className="text-sm leading-relaxed">
        {block.title && <p className="font-semibold">{block.title}</p>}
        <p>{block.text}</p>
      </div>
    </aside>
  );
}
