'use client';

// Duplicate-procedure chooser. Shown from the procedure editor and the
// content-pack detail row. Loads draft versions in the caller's scope,
// lets the user pick a target, then POSTs to /admin/procedures/:id/duplicate
// and routes them to the new doc's editor.
//
// Targets only appear when the pack has at least one draft version — the
// duplicate has to land somewhere editable. Empty state nudges the user
// to create a draft on the target pack first.

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search } from 'lucide-react';
import { useToast } from '@/components/toast';
import {
  duplicateProcedure,
  listDuplicateTargets,
  type DuplicateTarget,
} from '@/lib/api';

const LAYER_LABEL: Record<DuplicateTarget['layerType'], string> = {
  base: 'Base',
  dealer_overlay: 'Dealer overlay',
  site_overlay: 'Site overlay',
};

export function DuplicateProcedureDialog({
  sourceDocumentId,
  sourceTitle,
  currentVersionId,
  onClose,
}: {
  sourceDocumentId: string;
  sourceTitle: string;
  /** Current pack version of the source. Excluded from the target list
   *  (duplicating into the same version would just clutter it). */
  currentVersionId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [targets, setTargets] = useState<DuplicateTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState(`Copy of ${sourceTitle}`);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listDuplicateTargets()
      .then((rows) => {
        if (!cancelled) setTargets(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!targets) return null;
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) =>
      [t.packName, t.packSlug, t.assetModel, t.owner]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [targets, query]);

  async function pick(target: DuplicateTarget) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await duplicateProcedure({
        sourceDocumentId,
        targetVersionId: target.versionId,
        title: title.trim() || undefined,
      });
      toast.success(
        'Procedure duplicated',
        `${result.title} (${result.stepCount} step${result.stepCount === 1 ? '' : 's'}) is now in ${target.packName} v${target.versionLabel ?? target.versionNumber}.`,
      );
      router.push(`/procedures/${encodeURIComponent(result.documentId)}/edit`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-primary/40 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line-subtle px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-ink-primary">
              Duplicate procedure
            </span>
            <span className="truncate text-xs text-ink-tertiary">
              From "{sourceTitle}"
            </span>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Close"
            className="rounded p-1 text-ink-tertiary hover:bg-surface hover:text-ink-primary"
          >
            ×
          </button>
        </header>

        <div className="flex flex-col gap-3 border-b border-line-subtle px-4 py-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-ink-secondary">New title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
              placeholder={`Copy of ${sourceTitle}`}
            />
          </label>
          <label className="relative block">
            <Search
              size={14}
              strokeWidth={2}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search packs, models, or owners"
              className="h-9 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand focus:outline-none"
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <p className="mx-3 my-3 rounded border border-signal-fault/40 bg-signal-fault/10 p-3 text-sm text-signal-fault">
              {error}
            </p>
          )}
          {targets === null ? (
            <p className="px-3 py-10 text-center text-sm text-ink-tertiary">
              <Loader2 className="mx-auto mb-2 size-4 animate-spin" />
              Loading draft versions…
            </p>
          ) : filtered && filtered.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-ink-secondary">
                {query
                  ? 'No draft versions match the search.'
                  : 'No draft versions available to duplicate into.'}
              </p>
              {!query && (
                <p className="mt-1 text-xs text-ink-tertiary">
                  Create a draft on a pack first — see{' '}
                  <Link
                    href="/content-packs"
                    className="text-brand hover:underline"
                    onClick={onClose}
                  >
                    Content packs
                  </Link>
                  .
                </p>
              )}
            </div>
          ) : (
            <ul className="flex flex-col gap-1 p-2">
              {(filtered ?? []).map((t) => {
                const isSourceVersion = t.versionId === currentVersionId;
                return (
                  <li key={t.versionId}>
                    <button
                      type="button"
                      onClick={() => pick(t)}
                      disabled={busy}
                      className="flex w-full flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2 text-left text-sm transition hover:border-brand/40 hover:bg-brand/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-ink-primary">
                          {t.packName}
                        </span>
                        <span className="font-mono text-xs tabular-nums text-ink-tertiary">
                          v{t.versionLabel ?? t.versionNumber}
                        </span>
                        <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand">
                          {LAYER_LABEL[t.layerType]}
                        </span>
                        <span className="rounded-full bg-signal-info/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal-info">
                          draft
                        </span>
                        {isSourceVersion && (
                          <span className="rounded-full bg-ink-tertiary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
                            same draft
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-ink-tertiary">
                        {t.assetModel} · {t.owner}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {busy && (
          <div className="border-t border-line-subtle bg-surface px-4 py-2 text-xs text-ink-tertiary">
            <Loader2 className="mr-1.5 inline size-3 animate-spin" />
            Duplicating procedure…
          </div>
        )}
      </div>
    </div>
  );
}
