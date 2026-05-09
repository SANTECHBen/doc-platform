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
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import {
  getAdminDocument,
  listProcedureSteps,
  updateDocument,
  type AdminDocumentDetail,
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
  const [error, setError] = useState<string | null>(null);

  // Title editing — local-state mirror with debounced PATCH.
  const [title, setTitle] = useState('');
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [titleSaving, setTitleSaving] = useState(false);

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
      const s = await listProcedureSteps(docId);
      setDoc(d);
      setSteps(s);
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
        </div>
      </header>

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
          <ProcedureCmsEditor doc={doc} steps={steps} onChanged={refresh} />
        )}
      </div>
    </main>
  );
}
