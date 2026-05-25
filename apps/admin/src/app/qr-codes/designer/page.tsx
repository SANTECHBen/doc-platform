'use client';

// QR Code Designer — Bitly/Canva-style live editor. Sidebar with control
// panels (content, modules, eyes, colors, logo, frame), a center canvas
// rendering the styled QR live, a preset gallery row below, and an export
// dropdown that ships SVG or PNG at multiple resolutions.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Link2,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
} from 'lucide-react';
import { PageShell } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import { DEFAULT_QR_SPEC, specToFilenameRoot, type QrStyleSpec } from '@/lib/qr-style';
import { QrStylePreview, type QrStylePreviewHandle } from '@/components/qr-designer/qr-style-preview';
import { computeFrameGeometry, FrameChrome } from '@/components/qr-designer/qr-frame';
import {
  exportDesignedQr,
  QR_EXPORT_PRESETS,
  type QrExportFormat,
} from '@/components/qr-designer/qr-designer-export';
import { QR_STYLE_PRESETS } from '@/components/qr-designer/presets';
import {
  AdvancedPanel,
  ColorsPanel,
  ContentPanel,
  EyesPanel,
  FramePanel,
  LogoPanel,
  ModulesPanel,
} from '@/components/qr-designer/panels';
import { SaveDesignModal } from '@/components/qr-designer/save-design-modal';
import { SavedDesignsPanel } from '@/components/qr-designer/saved-designs-panel';
import { LegacyMigrationBanner } from '@/components/qr-designer/legacy-migration-banner';
import {
  defaultDesignName,
  fetchSavedDesigns,
  type SavedDesign,
} from '@/lib/qr-designer-storage';

const PREVIEW_PX = 360;

// The designer page reads ?data= (URL to encode) and ?context= (a label
// like "DEMO123ABCD · Square-Turn") from the query string. Next 15 forces
// useSearchParams() into a Suspense boundary, so we split into an outer
// wrapper and an inner component.
export default function QrDesignerPage() {
  return (
    <Suspense fallback={<PageShell crumbs={[{ label: 'QR codes', href: '/qr-codes' }, { label: 'Designer' }]}><p className="p-6 text-ink-tertiary">Loading…</p></PageShell>}>
      <QrDesignerInner />
    </Suspense>
  );
}

function QrDesignerInner() {
  const toast = useToast();
  const params = useSearchParams();
  const initialData = params?.get('data') ?? null;
  const contextLabel = params?.get('context') ?? null;
  const [spec, setSpec] = useState<QrStyleSpec>(() =>
    initialData ? { ...DEFAULT_QR_SPEC, data: initialData } : DEFAULT_QR_SPEC,
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [busyFormat, setBusyFormat] = useState<QrExportFormat | null>(null);
  const previewRef = useRef<QrStylePreviewHandle>(null);

  // Persistence state — list of designs fetched from the server, the id of
  // the currently-loaded design (so subsequent Save updates that entry),
  // loading + error state for the initial fetch, and a Save modal flag.
  const [savedDesigns, setSavedDesigns] = useState<SavedDesign[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const refreshSaved = useCallback(async () => {
    setSavedLoading(true);
    setSavedError(null);
    try {
      const rows = await fetchSavedDesigns();
      setSavedDesigns(rows);
    } catch (e) {
      setSavedError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavedLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSaved();
  }, [refreshSaved]);

  // If the query param changes after mount (rare — would only happen on
  // client-side navigation back into the designer with a different code),
  // sync the data field. We don't touch the rest of the spec so any styling
  // the user has already done is preserved.
  useEffect(() => {
    if (initialData) {
      setSpec((s) => (s.data === initialData ? s : { ...s, data: initialData }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData]);

  const onPatch = useCallback((patch: Partial<QrStyleSpec>) => {
    setSpec((s) => ({ ...s, ...patch }));
  }, []);

  const applyPreset = useCallback((presetId: string) => {
    const p = QR_STYLE_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    setSpec((s) => ({ ...s, ...p.patch } as QrStyleSpec));
  }, []);

  const onReset = useCallback(() => {
    setSpec(DEFAULT_QR_SPEC);
    setActiveSavedId(null);
    toast.success('Reset to defaults');
  }, [toast]);

  const onLoadSaved = useCallback(
    (design: SavedDesign) => {
      setSpec(design.spec);
      setActiveSavedId(design.id);
      toast.success('Loaded', design.name);
    },
    [toast],
  );

  const activeSavedDesign = useMemo(
    () => (activeSavedId ? savedDesigns.find((d) => d.id === activeSavedId) ?? null : null),
    [activeSavedId, savedDesigns],
  );

  const geometry = useMemo(() => computeFrameGeometry(spec, PREVIEW_PX), [spec]);

  async function onExport(format: QrExportFormat) {
    setBusyFormat(format);
    setExportOpen(false);
    try {
      await exportDesignedQr({
        spec,
        format,
        filename: `qr-${specToFilenameRoot(spec)}`,
      });
      toast.success('Downloaded', QR_EXPORT_PRESETS[format].label);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyFormat(null);
    }
  }

  return (
    <PageShell crumbs={[{ label: 'QR codes', href: '/qr-codes' }, { label: 'Designer' }]}>
      {/* Designer header — distinct from the standard PageHeader to make room
          for the export dropdown + reset action without crowding the title. */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/qr-codes"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-line text-ink-tertiary hover:bg-surface-inset"
            title="Back to QR codes"
            aria-label="Back to QR codes"
          >
            <ArrowLeft size={14} strokeWidth={2} />
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold text-ink-primary">QR Code Designer</h1>
              {contextLabel && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand"
                  title="The URL has been pre-filled from this QR code. Designing here doesn't change the tracked code — you're producing an artwork file for it."
                >
                  <Link2 size={10} strokeWidth={2} />
                  {contextLabel}
                </span>
              )}
            </div>
            <p className="text-xs text-ink-tertiary">
              {contextLabel
                ? 'URL pre-filled from the selected QR code. Style and export — the tracked code itself is unchanged.'
                : 'Style, brand, and export QR codes. Vector + high-resolution PNG.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1.5 rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-inset"
          >
            <RotateCcw size={13} strokeWidth={2} />
            Reset
          </button>
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            className="inline-flex items-center gap-1.5 rounded border border-line bg-surface px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-inset"
            title={activeSavedDesign ? `Save changes to "${activeSavedDesign.name}"` : 'Save this design'}
          >
            <Save size={13} strokeWidth={2} />
            {activeSavedDesign ? 'Save' : 'Save…'}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportOpen((v) => !v)}
              disabled={busyFormat !== null}
              className="inline-flex items-center gap-2 rounded btn-primary px-4 py-1.5 text-sm disabled:opacity-60"
            >
              {busyFormat ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <Download size={13} strokeWidth={2} />
              )}
              Download
              <ChevronDown size={12} strokeWidth={2} />
            </button>
            {exportOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setExportOpen(false)}
                  aria-hidden
                />
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1.5 w-56 overflow-hidden rounded-md border border-line bg-surface-raised shadow-xl"
                >
                  {(Object.keys(QR_EXPORT_PRESETS) as QrExportFormat[]).map((fmt) => (
                    <button
                      key={fmt}
                      role="menuitem"
                      onClick={() => onExport(fmt)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink-primary transition hover:bg-brand/5"
                    >
                      <span>{QR_EXPORT_PRESETS[fmt].label}</span>
                      <Download size={11} strokeWidth={2} className="text-ink-tertiary" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <LegacyMigrationBanner onCompleted={() => void refreshSaved()} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* Left sidebar — control panels. Scrollable independently from the
            preview area on tall pages. */}
        <aside className="space-y-3 lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto lg:pr-2">
          <ContentPanel spec={spec} onPatch={onPatch} />
          <ModulesPanel spec={spec} onPatch={onPatch} />
          <EyesPanel spec={spec} onPatch={onPatch} />
          <ColorsPanel spec={spec} onPatch={onPatch} />
          <LogoPanel spec={spec} onPatch={onPatch} />
          <FramePanel spec={spec} onPatch={onPatch} />
          <SavedDesignsPanel
            designs={savedDesigns}
            loading={savedLoading}
            loadError={savedError}
            activeId={activeSavedId}
            onLoad={onLoadSaved}
            onChange={(next) => {
              setSavedDesigns(next);
              // If the active design was deleted from the list, drop the
              // active marker so the Save button reverts to "Save…".
              if (activeSavedId && !next.find((d) => d.id === activeSavedId)) {
                setActiveSavedId(null);
              }
            }}
            onError={(msg) => toast.error(msg)}
            onOpenSaveDialog={() => setSaveOpen(true)}
            onRetry={() => void refreshSaved()}
          />
          <AdvancedPanel onReset={onReset} />
        </aside>

        {/* Center — live preview with composited frame chrome */}
        <div className="space-y-4">
          <section className="rounded-xl border border-line-subtle bg-[linear-gradient(135deg,#f6f6f7_0%,#eef0f3_100%)] p-8 shadow-inner">
            <div className="mx-auto flex flex-col items-center gap-6">
              <div
                className="relative"
                style={{
                  width: PREVIEW_PX,
                  height: PREVIEW_PX,
                }}
              >
                {/* Frame chrome behind the QR — only renders when frame.kind !== 'none' */}
                <FrameChrome frame={spec.frame} geometry={geometry} />
                {/* The QR engine renders here. Positioned inside the frame
                    via the computed geometry. */}
                <div
                  style={{
                    position: 'absolute',
                    left: geometry.qrX,
                    top: geometry.qrY,
                    width: geometry.qrPixel,
                    height: geometry.qrPixel,
                  }}
                >
                  <QrStylePreview ref={previewRef} spec={spec} pixelSize={geometry.qrPixel} />
                </div>
              </div>

              <div className="flex flex-col items-center gap-1.5 text-center">
                <p className="font-mono text-xs text-ink-tertiary">{spec.data || '—'}</p>
                <p className="text-[11px] text-ink-tertiary">
                  Live preview at {PREVIEW_PX}px. Downloads render at the chosen
                  resolution — SVG is vector and scales infinitely.
                </p>
              </div>
            </div>
          </section>

          {/* Preset gallery row */}
          <section className="rounded-xl border border-line-subtle bg-surface-raised p-4">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={14} strokeWidth={2} className="text-brand" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">
                Style presets
              </h2>
              <span className="text-[11px] text-ink-tertiary">
                One click — your URL and logo are preserved.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {QR_STYLE_PRESETS.map((p) => (
                <PresetCard key={p.id} preset={p} onApply={() => applyPreset(p.id)} />
              ))}
            </div>
          </section>
        </div>
      </div>

      {saveOpen && (
        <SaveDesignModal
          spec={spec}
          existing={activeSavedDesign}
          defaultName={defaultDesignName(spec)}
          onClose={() => setSaveOpen(false)}
          onSaved={(design) => {
            // Re-fetch the full list so a new entry appears in the right
            // sort position (sorted by server-side updatedAt) and remember
            // the active id so subsequent Save clicks default to updating
            // this entry.
            void refreshSaved();
            setActiveSavedId(design.id);
            setSaveOpen(false);
            toast.success('Saved', design.name);
          }}
        />
      )}
    </PageShell>
  );
}

function PresetCard({
  preset,
  onApply,
}: {
  preset: (typeof QR_STYLE_PRESETS)[number];
  onApply: () => void;
}) {
  // The preview-of-a-preview is a small static SVG depiction — not the full
  // engine render. The engine's per-instance startup cost (~5-15ms × 12)
  // would jitter the page; static thumbs keep the gallery snappy.
  const dotColor = preset.patch.dotColor;
  const fg = !dotColor
    ? '#0a0c0f'
    : dotColor.mode === 'solid'
      ? dotColor.color
      : dotColor.stops[0]?.color ?? '#0a0c0f';
  const bg =
    preset.patch.background?.mode === 'solid' ? preset.patch.background.color : '#ffffff';
  return (
    <button
      type="button"
      onClick={onApply}
      className="group flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2 text-left transition hover:border-brand/40 hover:bg-brand/5"
    >
      <div
        className="relative aspect-square w-full overflow-hidden rounded"
        style={{ backgroundColor: bg }}
      >
        <PresetThumbDots dotShape={preset.patch.dotShape ?? 'square'} fg={fg} />
        {preset.patch.frame?.kind === 'callout' && (
          <div
            className="absolute inset-0 rounded"
            style={{
              border: `8px solid ${preset.patch.frame.fill}`,
              borderRadius: 6,
            }}
          />
        )}
      </div>
      <div>
        <div className="text-xs font-semibold text-ink-primary group-hover:text-brand">
          {preset.label}
        </div>
        <div className="line-clamp-1 text-[10px] text-ink-tertiary">{preset.hint}</div>
      </div>
    </button>
  );
}

// Tiny 5×5 dot-grid that hints at the preset's module style — purely
// decorative; the live engine reflects the real result on apply.
function PresetThumbDots({ dotShape, fg }: { dotShape: string; fg: string }) {
  const pattern: number[][] = [
    [1, 1, 1, 0, 1],
    [1, 0, 1, 1, 0],
    [0, 1, 1, 0, 1],
    [1, 1, 0, 1, 1],
    [0, 1, 1, 1, 0],
  ];
  const cell = 100 / 5;
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      {pattern.flatMap((row, ry) =>
        row.map((on, rx) => {
          if (!on) return null;
          const x = rx * cell + cell * 0.15;
          const y = ry * cell + cell * 0.15;
          const s = cell * 0.7;
          if (dotShape === 'dots') {
            return (
              <circle
                key={`${rx}-${ry}`}
                cx={x + s / 2}
                cy={y + s / 2}
                r={s / 2}
                fill={fg}
              />
            );
          }
          const r = dotShape === 'extra-rounded' ? s * 0.4 : dotShape === 'rounded' || dotShape.startsWith('classy') ? s * 0.2 : 0;
          return (
            <rect key={`${rx}-${ry}`} x={x} y={y} width={s} height={s} rx={r} fill={fg} />
          );
        }),
      )}
    </svg>
  );
}
