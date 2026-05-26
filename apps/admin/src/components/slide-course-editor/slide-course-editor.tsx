'use client';

// SlideCourseEditor — top-level three-pane shell for authoring a slide
// course. Owns the deck state (slides + interactions) and routes mutations
// through the typed admin API client. Polls the conversion status while
// it's pending/processing so authors see when LibreOffice rendering
// completes without manual refresh.
//
// Layout:
//   ┌────────────────────────────────────────────────────────────────┐
//   │ Header: deck title, status pill, "Back to document" link       │
//   ├──────────┬─────────────────────────────────┬───────────────────┤
//   │  Slide   │  Slide canvas (PNG)              │  Slide settings   │
//   │  rail    │  + interaction badges            │  (tabs)           │
//   │  (left)  │                                  │  (right)          │
//   └──────────┴─────────────────────────────────┴───────────────────┘

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Loader2, Pencil, RefreshCcw, CheckCircle2 } from 'lucide-react';
import {
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
} from '@/components/form';
import { PageShell, PageHeader, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import {
  autoConvertDocumentToSlideDeck,
  createBlankSlide,
  createSlideDeckForDocument,
  deleteSlide,
  getSlideDeck,
  getSlideDeckByDocument,
  patchSlide,
  patchSlideDeck,
  replaceSlideImage,
  reorderSlides,
  retrySlideDeckConversion,
  uploadSlideImage,
  type SlideDeckDetail,
  type SlideDto,
  type SlideInteractionDto,
} from '@/lib/slide-course-api';
import { SlideRail } from './slide-rail';
import { SlideCanvas } from './slide-canvas';
import { SlideSettings } from './slide-settings';

const POLL_INTERVAL_MS = 3000;

export function SlideCourseEditor({ documentId }: { documentId: string }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  // Two-phase load: we have a documentId from the URL, need to look up
  // the slide deck. While conversion is pending/processing we keep
  // polling. Once 'ready' we fetch the full deck detail.
  const [deckId, setDeckId] = useState<string | null>(null);
  const [deck, setDeck] = useState<SlideDeckDetail | null>(null);
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);

  // ---------------------------------------------------------------------
  // Initial deck lookup. Refreshed by polling when status != ready.
  // ---------------------------------------------------------------------
  const refreshDeckSummary = useCallback(async () => {
    try {
      const summary = await getSlideDeckByDocument(documentId);
      if (!summary) {
        setDeckId(null);
        return;
      }
      setDeckId(summary.id);
      // Always re-fetch the detail when polling — slide rows get inserted
      // by the worker mid-conversion, and we want the rail to show the
      // count as it grows for visual progress.
      const detail = await getSlideDeck(summary.id);
      setDeck(detail);
      // Default selection: first slide, or persist the user's pick if it
      // still exists.
      setSelectedSlideId((prev) => {
        if (prev && detail.slides.some((s) => s.id === prev)) return prev;
        return detail.slides[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [documentId]);

  useEffect(() => {
    void refreshDeckSummary();
  }, [refreshDeckSummary]);

  // Poll until conversion finishes. The interval is intentionally generous
  // (3s) — a typical render takes 15-60s and the admin doesn't need
  // sub-second freshness.
  useEffect(() => {
    if (!deck) return;
    const status = deck.deck.conversionStatus;
    if (status === 'ready' || status === 'failed') return;
    const t = setInterval(() => void refreshDeckSummary(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [deck, refreshDeckSummary]);

  // ---------------------------------------------------------------------
  // Mutations — apply optimistically against local state, then reconcile.
  // ---------------------------------------------------------------------

  const applySlideUpdate = useCallback((slideId: string, patch: Partial<SlideDto>) => {
    setDeck((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        slides: prev.slides.map((s) => (s.id === slideId ? { ...s, ...patch } : s)),
      };
    });
  }, []);

  const applyInteractionsUpdate = useCallback(
    (slideId: string, next: SlideInteractionDto[]) => {
      setDeck((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          slides: prev.slides.map((s) =>
            s.id === slideId ? { ...s, interactions: next } : s,
          ),
        };
      });
    },
    [],
  );

  async function onPatchSlide(slideId: string, patch: Parameters<typeof patchSlide>[2]) {
    if (!deckId) return;
    // Optimistic
    applySlideUpdate(slideId, patch as Partial<SlideDto>);
    try {
      const updated = await patchSlide(deckId, slideId, patch);
      applySlideUpdate(slideId, updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refreshDeckSummary();
    }
  }

  async function onReorderSlides(orderings: { slideId: string; orderingHint: number }[]) {
    if (!deckId) return;
    setDeck((prev) => {
      if (!prev) return prev;
      const m = new Map(orderings.map((o) => [o.slideId, o.orderingHint]));
      return {
        ...prev,
        slides: [...prev.slides]
          .map((s) => ({ ...s, orderingHint: m.get(s.id) ?? s.orderingHint }))
          .sort((a, b) =>
            a.orderingHint === b.orderingHint
              ? a.slideIndex - b.slideIndex
              : a.orderingHint - b.orderingHint,
          ),
      };
    });
    try {
      await reorderSlides(deckId, orderings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refreshDeckSummary();
    }
  }

  async function onRename() {
    if (!deckId || !deck) return;
    const next = window.prompt('Rename course', deck.deck.documentTitle);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === deck.deck.documentTitle) return;
    try {
      const updated = await patchSlideDeck(deckId, { title: trimmed });
      setDeck((prev) => (prev ? { ...prev, deck: updated } : prev));
      toast.success('Course renamed', 'Updated in /training and on the PWA.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRetry() {
    if (!deckId) return;
    try {
      await retrySlideDeckConversion(deckId);
      toast.success('Retrying conversion', 'The worker will rebuild slides.');
      await refreshDeckSummary();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCreateDeck() {
    try {
      await createSlideDeckForDocument(documentId);
      await refreshDeckSummary();
      toast.success('Slide course created', 'Add slides manually with the + button in the rail.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onAutoConvert() {
    try {
      await autoConvertDocumentToSlideDeck(documentId);
      await refreshDeckSummary();
      toast.success(
        'Auto-conversion queued',
        'The worker is rendering your slides — they’ll appear as they finish.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Track in-flight batch upload so the UI can show progress.
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  async function onAddSlides(files: File[]) {
    if (!deckId || files.length === 0) return;
    // Natural-sort by filename so a user dropping "slide-1.png … slide-12.png"
    // gets them in numeric order, not lexicographic (slide-1, slide-10, slide-11, …).
    const sorted = [...files].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
    setBatchProgress({ done: 0, total: sorted.length });
    try {
      let lastCreatedId: string | null = null;
      // Sequential to keep slideIndex assignment deterministic on the server.
      for (let i = 0; i < sorted.length; i += 1) {
        const created = await uploadSlideImage(deckId, sorted[i]!);
        lastCreatedId = created.id;
        setDeck((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            deck: { ...prev.deck, slideCount: prev.deck.slideCount + 1 },
            slides: [...prev.slides, { ...created, interactions: [] }],
          };
        });
        setBatchProgress({ done: i + 1, total: sorted.length });
      }
      if (lastCreatedId) setSelectedSlideId(lastCreatedId);
      if (sorted.length > 1) {
        toast.success(`Uploaded ${sorted.length} slides`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchProgress(null);
    }
  }

  async function onAddBlankSlide() {
    if (!deckId) return;
    try {
      const created = await createBlankSlide(deckId, { title: 'Quiz' });
      setDeck((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          deck: { ...prev.deck, slideCount: prev.deck.slideCount + 1 },
          slides: [...prev.slides, { ...created, interactions: [] }],
        };
      });
      setSelectedSlideId(created.id);
      toast.success(
        'Quiz slide added',
        'Open the Interactions tab on the right to add the quiz questions.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onAddContentSlide() {
    if (!deckId) return;
    try {
      const created = await createBlankSlide(deckId, { title: 'New slide' });
      setDeck((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          deck: { ...prev.deck, slideCount: prev.deck.slideCount + 1 },
          slides: [...prev.slides, { ...created, interactions: [] }],
        };
      });
      setSelectedSlideId(created.id);
      toast.success(
        'Content slide added',
        'Open the Content tab on the right to add text, images, or videos.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onReplaceImage(slideId: string, file: File) {
    if (!deckId) return;
    try {
      const updated = await replaceSlideImage(deckId, slideId, file);
      setDeck((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          slides: prev.slides.map((s) =>
            s.id === slideId
              ? { ...s, ...updated, interactions: s.interactions }
              : s,
          ),
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDeleteSlide(slideId: string) {
    if (!deckId) return;
    if (!confirm('Delete this slide and all of its interactions?')) return;
    try {
      await deleteSlide(deckId, slideId);
      setDeck((prev) => {
        if (!prev) return prev;
        const next = prev.slides.filter((s) => s.id !== slideId);
        return {
          ...prev,
          deck: { ...prev.deck, slideCount: Math.max(prev.deck.slideCount - 1, 0) },
          slides: next,
        };
      });
      setSelectedSlideId((prev) => (prev === slideId ? deck?.slides[0]?.id ?? null : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const crumbs = [
    { label: 'Content packs', href: '/content-packs' },
    { label: 'Document', href: `/documents/${documentId}` },
    { label: 'Course' },
  ];

  if (!deck) {
    return (
      <PageShell crumbs={crumbs}>
        <PageHeader title="Slide course" />
        {error ? (
          <ErrorBanner error={error} />
        ) : !deckId ? (
          <NoDeckYet
            documentId={documentId}
            onCreate={onCreateDeck}
            onAutoConvert={onAutoConvert}
          />
        ) : (
          <LoadingPanel />
        )}
      </PageShell>
    );
  }

  const status = deck.deck.conversionStatus;
  const selectedSlide = deck.slides.find((s) => s.id === selectedSlideId) ?? null;

  return (
    <PageShell crumbs={crumbs}>
      <PageHeader
        title={`Slide course — ${deck.deck.documentTitle}`}
        description={
          <span className="flex items-center gap-2">
            <ConversionPill status={status} count={deck.deck.slideCount} />
            <span className="text-xs text-ink-tertiary">
              Pass threshold: {Math.round(deck.deck.passThreshold * 100)}%
            </span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/documents/${documentId}`}>
              <SecondaryButton type="button">
                <ArrowLeft className="size-4" /> Back to document
              </SecondaryButton>
            </Link>
            <SecondaryButton type="button" onClick={onRename}>
              <Pencil className="size-4" /> Rename
            </SecondaryButton>
            {status === 'failed' && (
              <PrimaryButton type="button" onClick={onRetry}>
                <RefreshCcw className="size-4" /> Retry conversion
              </PrimaryButton>
            )}
          </div>
        }
      />

      <ErrorBanner error={error} />

      {status === 'failed' && deck.deck.conversionError && (
        <div className="mb-4 flex items-start gap-3 rounded border border-signal-fault/40 bg-signal-fault/10 px-3 py-2 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-signal-fault" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-signal-fault">Conversion failed</p>
            <p className="mt-1 break-words text-xs text-ink-secondary">
              {deck.deck.conversionError}
            </p>
          </div>
        </div>
      )}

      {(status === 'pending' || status === 'processing') && (
        <div className="mb-4 flex items-center gap-3 rounded border border-line bg-surface-raised px-3 py-2 text-sm">
          <Loader2 className="size-4 animate-spin text-accent" />
          <span>
            Converting PowerPoint to slide images
            {deck.deck.slideCount > 0
              ? ` — ${deck.deck.slideCount} slide${deck.deck.slideCount === 1 ? '' : 's'} ready`
              : '…'}
          </span>
        </div>
      )}

      {batchProgress && (
        <div className="mb-3 flex items-center gap-3 rounded border border-line bg-surface-raised px-3 py-2 text-sm">
          <Loader2 className="size-4 animate-spin text-accent" />
          Uploading slide {batchProgress.done} of {batchProgress.total}…
        </div>
      )}
      {deck.slides.length === 0 ? (
        <EmptyDeckPanel
          onAddSlides={onAddSlides}
          onAddBlankSlide={onAddBlankSlide}
          status={status}
        />
      ) : (
        <div className="grid grid-cols-[260px_minmax(0,1fr)_360px] gap-4">
          <SlideRail
            slides={deck.slides}
            selectedSlideId={selectedSlideId}
            onSelect={setSelectedSlideId}
            onReorder={onReorderSlides}
            onAddSlides={onAddSlides}
            onAddBlankSlide={onAddBlankSlide}
            onAddContentSlide={onAddContentSlide}
          />
          <SlideCanvas
            slide={selectedSlide}
            onReplaceImage={
              selectedSlide
                ? (file) => onReplaceImage(selectedSlide.id, file)
                : undefined
            }
            onDeleteSlide={
              selectedSlide ? () => onDeleteSlide(selectedSlide.id) : undefined
            }
          />
          {selectedSlide && deckId && (
            <SlideSettings
              key={selectedSlide.id}
              deckId={deckId}
              slide={selectedSlide}
              onPatchSlide={(patch) => onPatchSlide(selectedSlide.id, patch)}
              onLocalUpdate={(patch) => applySlideUpdate(selectedSlide.id, patch)}
              onInteractionsChanged={(next) =>
                applyInteractionsUpdate(selectedSlide.id, next)
              }
              onError={(e) => setError(e)}
            />
          )}
        </div>
      )}
    </PageShell>
  );
}

function ConversionPill({
  status,
  count,
}: {
  status: SlideDeckDetail['deck']['conversionStatus'];
  count: number;
}) {
  if (status === 'ready') {
    return (
      <Pill tone="success">
        <CheckCircle2 className="size-3" /> Ready · {count} slides
      </Pill>
    );
  }
  if (status === 'failed') return <Pill tone="danger">Failed</Pill>;
  return <Pill tone="info">{status}</Pill>;
}

function LoadingPanel() {
  return (
    <div className="flex items-center gap-3 rounded border border-line bg-surface-raised px-4 py-3 text-sm text-ink-tertiary">
      <Loader2 className="size-4 animate-spin" /> Loading slide course…
    </div>
  );
}

function NoDeckYet({
  documentId,
  onCreate,
  onAutoConvert,
}: {
  documentId: string;
  onCreate: () => Promise<void> | void;
  onAutoConvert: () => Promise<void> | void;
}) {
  return (
    <div className="rounded border border-line bg-surface-raised p-6 text-sm">
      <p className="text-ink-secondary">
        This document doesn't have a slide course yet. Pick how you want
        to build one:
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink-primary">
            Auto-convert the PPTX
          </h3>
          <p className="text-xs text-ink-secondary">
            The worker renders every slide to a PNG using LibreOffice. Fast
            for simple decks; fidelity can suffer on custom fonts or
            complex animations.
          </p>
          <PrimaryButton type="button" onClick={() => void onAutoConvert()}>
            Auto-convert PPTX
          </PrimaryButton>
        </div>
        <div className="flex flex-col gap-2 rounded border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink-primary">
            Build it manually
          </h3>
          <p className="text-xs text-ink-secondary">
            Export each slide as a PNG from PowerPoint (File → Export → PNG)
            and upload them one at a time. Pixel-perfect and never times
            out.
          </p>
          <PrimaryButton type="button" onClick={() => void onCreate()}>
            Create blank course
          </PrimaryButton>
        </div>
      </div>
      <div className="mt-4">
        <Link href={`/documents/${documentId}`}>
          <SecondaryButton type="button">Back to document</SecondaryButton>
        </Link>
      </div>
    </div>
  );
}

// Shown when a deck row exists but has zero slides — typically after
// failed auto-conversion or right after manual deck creation.
function EmptyDeckPanel({
  onAddSlides,
  onAddBlankSlide,
  status,
}: {
  onAddSlides: (files: File[]) => Promise<void>;
  onAddBlankSlide: () => Promise<void> | void;
  status: SlideDeckDetail['deck']['conversionStatus'];
}) {
  return (
    <div className="rounded border border-dashed border-line bg-surface-raised p-8 text-center">
      <p className="text-sm text-ink-secondary">
        {status === 'failed'
          ? 'Auto-conversion failed for this deck. You can still build the course manually — select all your slide images at once below.'
          : 'This course has no slides yet. Export your slides from PowerPoint as PNGs (File → Export → Change File Type → PNG), then select them all at once below.'}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <label className="inline-flex">
          <PrimaryButton
            type="button"
            onClick={() =>
              (document.getElementById('first-slide-upload') as HTMLInputElement)?.click()
            }
          >
            Upload slide images
          </PrimaryButton>
          <input
            id="first-slide-upload"
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (files.length) void onAddSlides(files);
            }}
          />
        </label>
        <SecondaryButton type="button" onClick={() => void onAddBlankSlide()}>
          Add quiz slide (no image)
        </SecondaryButton>
      </div>
      <p className="mt-3 text-xs text-ink-tertiary">
        Tip: name your exports <code>slide-1.png</code>, <code>slide-2.png</code>… so
        they upload in order.
      </p>
    </div>
  );
}

