'use client';

// Full-page authoring view for a structured_procedure document.
//
// Distinct from /documents/[id]?tab=steps in three ways:
//   1. Full viewport — no PageShell sidebar, no breadcrumbs. Everything
//      that's not authoring chrome is gone, leaving the maximum canvas
//      for the content.
//   2. Inline title editing in the header (the only place to edit the
//      doc's name from this view).
//   3. Single back button instead of nav. The back button preserves the
//      pack-version → doc context so the author returns to where they
//      came from, not to the home page.
//
// The body is the same ProcedureCmsEditor used in the tab view; the
// step cards, drag-reorder, voiceover panel, and structured block
// editor all work identically. This route just gives them more room.

import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRightLeft,
  Copy,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { DuplicateProcedureDialog } from '@/components/duplicate-procedure-dialog';
import { useToast } from '@/components/toast';
import {
  getAdminDocument,
  getContentPack,
  listProcedureSections,
  listProcedureSteps,
  moveDocumentToVersion,
  updateDocument,
  type AdminContentPackDetail,
  type AdminDocumentDetail,
  type AdminProcedureSection,
  type AdminProcedureStep,
} from '@/lib/api';
import { ProcedureCmsEditor } from '@/components/procedure-cms/procedure-cms-editor';

export default function ProcedureFullPageEditor({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);
  const router = useRouter();
  const toast = useToast();

  const [doc, setDoc] = useState<AdminDocumentDetail | null>(null);
  const [steps, setSteps] = useState<AdminProcedureStep[] | null>(null);
  const [sections, setSections] = useState<AdminProcedureSection[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Title editing — local-state mirror with debounced PATCH.
  const [title, setTitle] = useState('');
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [titleSaving, setTitleSaving] = useState(false);

  // Move-to-version dialog state. Loaded lazily when the user opens the
  // picker so we don't fetch the full pack tree on every page load.
  const [moveOpen, setMoveOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [pack, setPack] = useState<AdminContentPackDetail | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);

  async function refresh() {
    try {
      const d = await getAdminDocument(docId);
      if (d.kind !== 'structured_procedure') {
        setError(
          'This document is not a structured procedure. Open it from the document detail page instead.',
        );
        setDoc(d);
        return;
      }
      const [s, secs] = await Promise.all([
        listProcedureSteps(docId),
        listProcedureSections(docId),
      ]);
      setDoc(d);
      setSteps(s);
      setSections(secs);
      setTitle(d.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  function onTitleChange(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(async () => {
      const v = next.trim();
      if (!doc || v.length === 0 || v === doc.title) return;
      setTitleSaving(true);
      try {
        await updateDocument(doc.id, { title: v });
        setDoc({ ...doc, title: v });
      } catch (e) {
        toast.error(
          'Could not save title',
          e instanceof Error ? e.message : String(e),
        );
      } finally {
        setTitleSaving(false);
      }
    }, 600);
  }

  function onClose() {
    if (doc) {
      // Return to the doc detail page they came from (or its overview).
      router.push(`/documents/${doc.id}`);
    } else {
      router.back();
    }
  }

  // Open the move-to-version dialog. Lazy-loads the pack so the version
  // list is fresh.
  async function openMove() {
    setMoveOpen(true);
    if (!doc) return;
    setPackLoading(true);
    try {
      const fresh = await getContentPack(doc.contentPackId);
      setPack(fresh);
    } catch (e) {
      toast.error('Could not load pack', e instanceof Error ? e.message : String(e));
    } finally {
      setPackLoading(false);
    }
  }

  async function doMove(targetVersionId: string) {
    if (!doc || moveBusy || targetVersionId === doc.contentPackVersionId) return;
    setMoveBusy(true);
    try {
      await moveDocumentToVersion({
        documentId: doc.id,
        targetVersionId,
      });
      toast.success('Procedure moved');
      setMoveOpen(false);
      // Refresh so the header shows the new version label and any
      // version-status banners flip appropriately.
      await refresh();
    } catch (e) {
      toast.error('Move failed', e instanceof Error ? e.message : String(e));
    } finally {
      setMoveBusy(false);
    }
  }

  if (error && !doc) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface p-6">
        <div className="max-w-lg rounded-md border border-signal-fault/40 bg-signal-fault/10 p-4 text-sm text-signal-fault">
          <p className="font-medium">Couldn&apos;t load procedure</p>
          <p className="mt-1 text-ink-secondary">{error}</p>
          <button
            type="button"
            onClick={() => router.back()}
            className="mt-3 inline-flex items-center gap-1.5 rounded border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-surface"
          >
            <ArrowLeft className="size-3.5" /> Back
          </button>
        </div>
      </main>
    );
  }
  if (!doc) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-surface text-sm text-ink-tertiary">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </main>
    );
  }

  const isPublished = doc.contentPackVersionStatus !== 'draft';

  return (
    <main className="min-h-screen bg-surface">
      {/* Top bar — minimal chrome. Title edits inline; status pill on
          the right. The back arrow returns to the document detail page
          rather than this app's home, so authors don't lose their place. */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface-raised/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link
            href={`/documents/${encodeURIComponent(doc.id)}`}
            className="inline-flex size-9 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-surface hover:text-ink-primary"
            aria-label="Back to document"
            onClick={(e) => {
              // SPA back when possible; let the link work as a fallback.
              if (typeof window !== 'undefined' && window.history.length > 1) {
                e.preventDefault();
                onClose();
              }
            }}
          >
            <ArrowLeft className="size-5" />
          </Link>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Procedure title"
              className="w-full bg-transparent text-lg font-semibold text-ink-primary outline-none placeholder:text-ink-tertiary/60"
              aria-label="Procedure title"
            />
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
              <span>
                {doc.contentPackName} — v{doc.contentPackVersionNumber}
              </span>
              <span>·</span>
              <span
                className={[
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                  isPublished
                    ? 'bg-signal-warn/10 text-signal-warn'
                    : 'bg-signal-info/10 text-signal-info',
                ].join(' ')}
              >
                {doc.contentPackVersionStatus}
              </span>
              {doc.safetyCritical && (
                <span className="inline-flex items-center gap-1 rounded-full bg-signal-warn/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal-warn">
                  <ShieldAlert className="size-3" /> safety
                </span>
              )}
              {titleSaving && (
                <span className="inline-flex items-center gap-1 text-accent">
                  <Loader2 className="size-3 animate-spin" />
                  Saving…
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setDupOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5"
            title="Copy this procedure into a different content pack draft"
          >
            <Copy className="size-3.5" />
            Duplicate…
          </button>
          <button
            type="button"
            onClick={openMove}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary transition hover:border-accent/40 hover:bg-accent/5"
            title="Move this procedure to a different version of the same content pack"
          >
            <ArrowRightLeft className="size-3.5" />
            Move…
          </button>
        </div>
      </header>

      {dupOpen && (
        <DuplicateProcedureDialog
          sourceDocumentId={doc.id}
          sourceTitle={title}
          currentVersionId={doc.contentPackVersionId}
          onClose={() => setDupOpen(false)}
        />
      )}

      {/* Banner — published versions are immutable. We allow edits via
          the existing additive-overlay model (steps are not frozen by
          publish), but warn explicitly so the author knows the constraint. */}
      {isPublished && (
        <div className="border-b border-signal-warn/30 bg-signal-warn/5 px-4 py-2 text-center text-xs text-signal-warn">
          This pack version is published. Step edits are still allowed (additive
          overlays). For structural rewrites, create a new draft version.
        </div>
      )}

      <div className="mx-auto max-w-5xl px-4 py-6">
        {steps !== null && (
          <ProcedureCmsEditor
            doc={doc}
            steps={steps}
            sections={sections}
            onChanged={refresh}
          />
        )}
      </div>

      {moveOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink-primary/40 backdrop-blur-sm p-4"
          onClick={() => !moveBusy && setMoveOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-ink-primary">
                  Move procedure to a different version
                </span>
                <span className="text-xs text-ink-tertiary">
                  Currently in v{doc.contentPackVersionNumber}
                  {doc.contentPackVersionStatus === 'draft' ? ' (draft)' : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => !moveBusy && setMoveOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-ink-tertiary hover:bg-surface hover:text-ink-primary"
              >
                ×
              </button>
            </header>

            <div className="max-h-80 overflow-y-auto p-2">
              {packLoading || !pack ? (
                <p className="px-3 py-6 text-center text-sm text-ink-tertiary">
                  <Loader2 className="mx-auto mb-2 size-4 animate-spin" />
                  Loading versions…
                </p>
              ) : pack.versions.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-ink-tertiary">
                  No other versions in this pack.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {[...pack.versions]
                    .sort((a, b) => b.versionNumber - a.versionNumber)
                    .map((v) => {
                      const current = v.id === doc.contentPackVersionId;
                      return (
                        <li key={v.id}>
                          <button
                            type="button"
                            onClick={() => doMove(v.id)}
                            disabled={moveBusy || current}
                            className={[
                              'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition',
                              current
                                ? 'cursor-not-allowed bg-surface text-ink-tertiary'
                                : 'hover:bg-accent/5 hover:text-accent',
                            ].join(' ')}
                          >
                            <span className="flex items-center gap-2">
                              <span className="font-mono text-xs tabular-nums text-ink-tertiary">
                                v{v.versionLabel ?? v.versionNumber}
                              </span>
                              <span
                                className={[
                                  'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
                                  v.status === 'published'
                                    ? 'bg-signal-warn/10 text-signal-warn'
                                    : v.status === 'draft'
                                      ? 'bg-signal-info/10 text-signal-info'
                                      : 'bg-surface text-ink-tertiary',
                                ].join(' ')}
                              >
                                {v.status}
                              </span>
                              <span className="text-xs text-ink-tertiary">
                                {v.documents.length} doc
                                {v.documents.length === 1 ? '' : 's'}
                              </span>
                            </span>
                            {current ? (
                              <span className="text-xs text-ink-tertiary">current</span>
                            ) : (
                              <span className="text-xs font-medium text-accent">
                                Move →
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                </ul>
              )}
            </div>
            {moveBusy && (
              <div className="border-t border-line-subtle bg-surface px-4 py-2 text-xs text-ink-tertiary">
                <Loader2 className="mr-1.5 inline size-3 animate-spin" />
                Moving…
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
