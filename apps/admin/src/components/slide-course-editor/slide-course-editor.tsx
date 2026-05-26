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
import { AlertCircle, ArrowLeft, Loader2, RefreshCcw, CheckCircle2 } from 'lucide-react';
import {
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
} from '@/components/form';
import { PageShell, PageHeader, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import {
  getSlideDeck,
  getSlideDeckByDocument,
  patchSlide,
  reorderSlides,
  retrySlideDeckConversion,
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
          <NoDeckYet documentId={documentId} />
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

      {deck.slides.length === 0 ? (
        <LoadingPanel />
      ) : (
        <div className="grid grid-cols-[260px_minmax(0,1fr)_360px] gap-4">
          <SlideRail
            slides={deck.slides}
            selectedSlideId={selectedSlideId}
            onSelect={setSelectedSlideId}
            onReorder={onReorderSlides}
          />
          <SlideCanvas slide={selectedSlide} />
          {selectedSlide && deckId && (
            <SlideSettings
              key={selectedSlide.id}
              deckId={deckId}
              slide={selectedSlide}
              onPatchSlide={(patch) => onPatchSlide(selectedSlide.id, patch)}
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

function NoDeckYet({ documentId }: { documentId: string }) {
  return (
    <div className="rounded border border-line bg-surface-raised p-6 text-sm">
      <p className="text-ink-secondary">
        This document doesn't have a slide course yet. Slide courses are created
        automatically when a PPTX file is uploaded — the extraction worker
        renders each slide to a PNG, and from there you author voiceover,
        interactions, and navigation.
      </p>
      <p className="mt-3 text-ink-tertiary">
        If you just uploaded a PPTX, refresh this page in a few seconds.{' '}
        <Link href={`/documents/${documentId}`} className="text-accent underline">
          Back to document
        </Link>
        .
      </p>
    </div>
  );
}

