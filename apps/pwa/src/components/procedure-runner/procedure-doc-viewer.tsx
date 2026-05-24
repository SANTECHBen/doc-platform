'use client';

// ProcedureDocViewer — read-only rendering of a structured_procedure
// document with the fixed template applied (Title → Tools → optional
// Safety → Steps → optional Verification). Distinct from the runner
// (which captures evidence). Tap "Run with evidence" to launch the
// runner against the same doc.

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Camera,
  Check,
  ChevronLeft,
  ClipboardCheck,
  Clock,
  FileText,
  GraduationCap,
  Headphones,
  ListChecks,
  Play,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import {
  getProcedureDoc,
  type ProcedureDocFullDto,
  type ProcedureStepKind,
} from '@/lib/api';
import { StepVideoPlayer } from '../step-video-player';
import { HeroVideoEmbed } from '../hero-video-embed';
import { MuxClipPlayer } from '../mux-clip-player';
import { capitalize, formatDuration } from '@/lib/format';

export function ProcedureDocViewer({
  docId,
  devUserId,
  devOrgId,
  onClose,
  onRunWithEvidence,
  onOpenJobAid,
}: {
  docId: string;
  devUserId: string;
  devOrgId: string;
  onClose: () => void;
  /** Caller is responsible for opening the runner — keeps the viewer
   *  unaware of routing. Passing null hides the button (e.g., when the
   *  user isn't authed for write paths). */
  onRunWithEvidence: (() => void) | null;
  /** Toggle to the hands-free Job Aid view (VirtualJobAid). When
   *  supplied, renders a button next to "Run with evidence". */
  onOpenJobAid?: (() => void) | null;
}) {
  const [doc, setDoc] = useState<ProcedureDocFullDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const full = await getProcedureDoc(docId, devUserId, devOrgId);
        if (!cancelled) setDoc(full);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, devUserId, devOrgId]);

  if (error && !doc) {
    return (
      <div className="doc-overlay" role="dialog" aria-modal="true">
        <header className="doc-overlay-bar">
          <button
            type="button"
            onClick={onClose}
            className="app-topbar-btn"
            aria-label="Close"
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <div className="doc-overlay-title">
            <span className="caption">Procedure</span>
            <h2 className="truncate text-base font-semibold">
              Couldn&apos;t load procedure
            </h2>
          </div>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <p className="text-signal-fault">{error}</p>
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Back
          </button>
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="doc-overlay" role="dialog" aria-modal="true">
        <header className="doc-overlay-bar">
          <button
            type="button"
            onClick={onClose}
            className="app-topbar-btn"
            aria-label="Close"
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <div className="doc-overlay-title">
            <span className="caption">Procedure</span>
            <h2 className="truncate text-base font-semibold">Loading…</h2>
          </div>
        </header>
      </div>
    );
  }

  const m = doc.metadata;
  const stepCount = doc.steps.length;

  return (
    <div
      className="doc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={doc.document.title}
    >
      <header
        className="doc-overlay-bar"
        style={{
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 8,
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="app-topbar-btn"
            aria-label="Close"
          >
            <ChevronLeft size={22} strokeWidth={2} />
          </button>
          <div className="doc-overlay-title">
            <span className="inline-flex items-center gap-1.5 caption">
              <ListChecks size={12} strokeWidth={1.75} />
              PROCEDURE
              {doc.document.source === 'field' && (
                <span
                  className={`ml-1 inline-flex items-center gap-1 rounded-sm border px-1 py-0.5 text-[10px] uppercase ${
                    doc.document.verified
                      ? 'border-signal-ok/40 bg-signal-ok/10 text-signal-ok'
                      : 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
                  }`}
                >
                  {doc.document.verified ? '✓ verified' : '⚠ unverified'} · field
                </span>
              )}
            </span>
            <h2 className="truncate text-base font-semibold">{doc.document.title}</h2>
          </div>
        </div>
        {(onOpenJobAid || onRunWithEvidence) && (
          <div className="flex flex-wrap items-center gap-2">
            {onOpenJobAid && (
              <button
                type="button"
                onClick={onOpenJobAid}
                className="btn btn-secondary btn-sm"
                title="Step-by-step hands-free walkthrough with voiceover"
              >
                <Headphones size={14} strokeWidth={2} /> Job Aid view
              </button>
            )}
            {onRunWithEvidence && (
              <button
                type="button"
                onClick={onRunWithEvidence}
                className="btn btn-primary btn-sm"
              >
                <Play size={14} strokeWidth={2} /> Run with evidence
              </button>
            )}
          </div>
        )}
      </header>

      <div className="doc-overlay-scroll">
        {/* HERO BLOCK — full-bleed when the procedure has a hero video,
            rendered OUTSIDE the article's max-width container so it
            spans edge-to-edge. No text overlay — the title and meta
            chips live in the header below so the video frame stays
            uncovered. */}
        {m?.heroVideo ? (
          <div className="hero-prominent">
            <HeroVideoEmbed
              url={m.heroVideo.url}
              alt={`${doc.document.title} intro video`}
              caption={m.heroVideo.caption ?? null}
              muted={false}
              playId="hero"
            />
          </div>
        ) : null}
        <article className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold tracking-tight text-ink-primary">
              {doc.document.title}
            </h1>
            {doc.document.capturedByDisplayName && (
              <p className="text-sm text-ink-tertiary">
                Captured by {doc.document.capturedByDisplayName}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono tabular-nums text-ink-tertiary">
                {stepCount} step{stepCount === 1 ? '' : 's'}
              </span>
              {m?.estimatedMinutes != null && (
                <span className="inline-flex items-center gap-1 rounded-full border border-brand/40 px-2.5 py-1 text-xs font-medium text-ink-primary">
                  <Clock size={12} strokeWidth={2.25} className="text-brand" />
                  {formatDuration(m.estimatedMinutes)}
                </span>
              )}
              {m?.skillLevel && (
                <span className="inline-flex items-center gap-1 rounded-full border border-brand/40 px-2.5 py-1 text-xs font-medium text-ink-primary">
                  <GraduationCap
                    size={12}
                    strokeWidth={2.25}
                    className="text-brand"
                  />
                  {capitalize(m.skillLevel)}
                </span>
              )}
            </div>
          </header>

          {/* GENERAL INFORMATION — single transparent card with
              bordered subsections. Order matches the Job Aid intro:
              Required Tools → Description → Safety. */}
          {(() => {
            if (!m) return null;
            // Accept legacy flat array OR new { common, special,
            // consumables } shape. API serves canonical now; legacy
            // fallback covers stale clients.
            const raw = m.toolsRequired as unknown;
            const tools = Array.isArray(raw)
              ? { common: raw as string[], special: [], consumables: [] }
              : {
                  common: (raw as { common?: string[] })?.common ?? [],
                  special: (raw as { special?: string[] })?.special ?? [],
                  consumables:
                    (raw as { consumables?: string[] })?.consumables ?? [],
                };
            const anyTools =
              tools.common.length > 0 ||
              tools.special.length > 0 ||
              tools.consumables.length > 0;
            if (!m.summary && !anyTools && !m.safety.enabled) return null;
            return (
              <section className="flex flex-col rounded-md border border-line">
                <h2 className="border-b border-line px-5 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink-tertiary">
                  General Information
                </h2>
                <div className="flex flex-col divide-y divide-line/60 px-5 py-4">
                  {anyTools && (
                    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
                        <Wrench size={14} strokeWidth={2.25} className="text-brand" />
                        Required Tools
                      </h3>
                      <ToolBucket label="Common Tools" items={tools.common} />
                      <ToolBucket label="Special Tools" items={tools.special} />
                      <ToolBucket label="Consumables" items={tools.consumables} />
                    </div>
                  )}
                  {m.summary && (
                    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
                        <FileText size={14} strokeWidth={2.25} className="text-brand" />
                        Description
                      </h3>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">
                        {m.summary}
                      </p>
                    </div>
                  )}
                  {m.safety.enabled && (
                    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-signal-safety">
                        <ShieldAlert size={14} strokeWidth={2.25} />
                        Safety
                      </h3>
                      <div className="rounded-md border border-signal-safety/40 bg-signal-safety/5 p-3">
                        {m.safety.notes ? (
                          <div className="markdown-body text-sm">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {m.safety.notes}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <p className="text-sm italic text-ink-tertiary">
                            Safety section enabled with no notes.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            );
          })()}

          {/* STEPS — when the procedure has named sections, render one
              group per section with step numbering restarting at 1 inside
              each. Orphan steps (sectionId === null) render under the
              default "Steps" header at the top. Unsection­ed procedures
              keep the original single-list layout. */}
          {(() => {
            const sections = doc.sections ?? [];
            // Group steps by their sectionId (orphans = null).
            const byId = new Map<string, typeof doc.steps>();
            const orphans: typeof doc.steps = [];
            for (const s of doc.steps) {
              if (s.sectionId == null) {
                orphans.push(s);
              } else {
                const arr = byId.get(s.sectionId) ?? [];
                arr.push(s);
                byId.set(s.sectionId, arr);
              }
            }
            const sortedSections = [...sections].sort(
              (a, b) => a.orderingHint - b.orderingHint,
            );
            return (
              <>
                {orphans.length > 0 && (
                  <section className="flex flex-col gap-3">
                    <SectionHeader icon={ListChecks} label="Steps" />
                    <ol className="flex flex-col gap-3">
                      {orphans.map((s, i) => (
                        <StepBlock key={s.id} step={s} index={i + 1} />
                      ))}
                    </ol>
                  </section>
                )}
                {sortedSections.map((sec) => {
                  const groupSteps = byId.get(sec.id) ?? [];
                  if (groupSteps.length === 0) return null;
                  return (
                    <section key={sec.id} className="flex flex-col gap-3">
                      <SectionHeader icon={ListChecks} label={sec.title} />
                      {sec.description && (
                        <p className="text-sm text-ink-secondary">{sec.description}</p>
                      )}
                      <ol className="flex flex-col gap-3">
                        {groupSteps.map((s, i) => (
                          <StepBlock key={s.id} step={s} index={i + 1} />
                        ))}
                      </ol>
                    </section>
                  );
                })}
              </>
            );
          })()}

          {/* VERIFICATION — when enabled */}
          {m?.verification.enabled && (
            <section className="flex flex-col gap-2">
              <SectionHeader
                icon={Check}
                label="Verification"
                color="text-signal-ok"
              />
              <div className="rounded-md border border-signal-ok/40 bg-signal-ok/5 p-4">
                {m.verification.notes ? (
                  <div className="markdown-body text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.verification.notes}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="text-sm italic text-ink-tertiary">
                    Verification section enabled with no notes.
                  </p>
                )}
              </div>
            </section>
          )}
        </article>
      </div>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  color,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  label: string;
  color?: string;
}) {
  return (
    <h2 className={`flex items-center gap-2 text-lg font-semibold ${color ?? 'text-ink-primary'}`}>
      <Icon size={18} strokeWidth={1.75} />
      {label}
    </h2>
  );
}

function StepBlock({
  step,
  index,
}: {
  step: ProcedureDocFullDto['steps'][number];
  index: number;
}) {
  return (
    <li
      className={`relative rounded-md border p-4 ${
        step.safetyCritical
          ? 'border-signal-safety/40 bg-signal-safety/5'
          : 'border-line bg-surface-raised'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="font-mono tabular-nums text-sm font-semibold text-ink-tertiary shrink-0 mt-0.5">
          {String(index).padStart(2, '0')}
        </span>
        <div className="flex flex-1 flex-col gap-3 min-w-0">
          <header className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink-primary flex-1 min-w-0">
              {step.title}
            </h3>
            <KindBadge kind={step.kind} />
            {step.safetyCritical && (
              <span className="inline-flex items-center gap-1 rounded-sm border border-signal-safety/40 bg-signal-safety/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-signal-safety">
                <ShieldAlert size={10} strokeWidth={2} /> Safety-critical
              </span>
            )}
          </header>
          {step.bodyMarkdown && (
            <div className="markdown-body text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {step.bodyMarkdown}
              </ReactMarkdown>
            </div>
          )}
          {step.media.length > 0 && (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {step.media.map((m, mi) => (
                <li
                  key={`${m.storageKey}-${mi}`}
                  className="overflow-hidden rounded border border-line-subtle bg-surface-inset"
                >
                  {m.kind === 'image' ? (
                    <img
                      src={m.url ?? ''}
                      alt={m.caption ?? ''}
                      className="h-auto w-full"
                    />
                  ) : m.kind === 'video_clip' ? (
                    // AI-drafted clip range — streams from Mux HLS,
                    // clamped to [startMs..endMs]. Doc viewer is a
                    // scrollable list, so we opt out of autoplay
                    // (passing autoplay=false makes it tap-to-play)
                    // to avoid a dozen clips fighting for bandwidth
                    // on a long procedure. The runner / Job Aid view
                    // autoplays the active step's clip; see below.
                    <MuxClipPlayer
                      streamUrl={m.clip.streamUrl}
                      startMs={m.clip.startMs}
                      endMs={m.clip.endMs}
                      posterUrl={m.url ?? undefined}
                      alt={m.caption ?? step.title}
                      caption={m.caption ?? null}
                      muted
                      autoplay={false}
                      aspectRatio={m.clip.aspectRatio ?? null}
                      orientation={m.clip.orientation ?? null}
                      playId={`viewer-${step.id ?? index}-${mi}`}
                    />
                  ) : (
                    <video
                      src={m.url ?? ''}
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="auto"
                      className="h-auto w-full"
                    />
                  )}
                  {m.caption && m.kind !== 'video_clip' && (
                    <p className="px-3 py-2 text-xs text-ink-secondary">
                      {m.caption}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {step.substeps.length > 0 && (
            <ol className="mt-2 flex flex-col gap-2">
              {step.substeps.map((ss, si) => (
                <li
                  key={ss.id ?? si}
                  className="grid grid-cols-[28px_1fr] items-start gap-x-3 rounded-[10px] border border-line/60 bg-surface-raised/60 px-3.5 py-3"
                >
                  <span
                    aria-hidden
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand/15 text-xs font-bold text-brand"
                  >
                    {si + 1}
                  </span>
                  <span className="text-[15px] font-semibold leading-snug text-ink-primary">
                    {ss.title}
                  </span>
                  {ss.bodyMarkdown && (
                    <div className="col-start-2 mt-1 text-sm leading-relaxed text-ink-secondary markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {ss.bodyMarkdown}
                      </ReactMarkdown>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </li>
  );
}

function KindBadge({ kind }: { kind: ProcedureStepKind }) {
  // 'instruction' is the default kind. Rendering an INSTR chip on every
  // step just adds visual noise — only show the chip for kinds that
  // actually change what the tech has to do (evidence required, safety).
  if (kind === 'instruction') return null;
  const Icon =
    kind === 'photo_required'
      ? Camera
      : kind === 'safety_check'
        ? ShieldAlert
        : ClipboardCheck;
  const label =
    kind === 'photo_required'
      ? 'PHOTO'
      : kind === 'measurement_required'
        ? 'MEASURE'
        : 'SAFETY';
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-line-subtle bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-tertiary">
      <Icon size={10} strokeWidth={1.75} />
      {label}
    </span>
  );
}

// Labeled tool bucket used three times in the General Information
// section (Common / Special / Consumables). Renders nothing when the
// list is empty so callers don't need to guard.
function ToolBucket({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-ink-secondary">
        {label}:
      </span>
      <ul className="flex flex-col gap-1 pl-1">
        {items.map((t, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <Check
              size={14}
              strokeWidth={2}
              className="shrink-0 text-ink-tertiary"
            />
            <span className="text-ink-primary">{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
