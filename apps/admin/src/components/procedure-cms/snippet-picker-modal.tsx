'use client';

// SnippetPickerModal — modal picker for inserting a reusable step snippet
// into the current procedure. Mirrors the LinkedSubProcedurePicker UX
// (search box + grouped list) but operates against /admin/snippets.
//
// Two tiers render as visually separated sections in the list:
//   Platform snippets (SANTECH globals) — shown first with a globe icon.
//   Org snippets — grouped under "Your org".
//
// Selecting a snippet calls onPick(snippet); the parent then creates a
// step with snippetId set. We don't insert the step from here — keeping
// "pick" and "create" separate lets the parent choose where to land the
// step (current section vs orphan) without us knowing.

import { useEffect, useMemo, useState } from 'react';
import { Globe2, Search, X, FileText, ShieldAlert, Camera, Ruler } from 'lucide-react';
import {
  listAdminSnippets,
  type AdminSnippet,
  type ProcedureStepKind,
} from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (snippet: AdminSnippet) => void;
  /** When set, narrows search to that org plus platform-tier snippets.
   *  Typically the document's owner organization. */
  ownerOrganizationId?: string | null;
}

const KIND_ICON: Record<ProcedureStepKind, typeof FileText> = {
  instruction: FileText,
  safety_check: ShieldAlert,
  photo_required: Camera,
  measurement_required: Ruler,
};

const KIND_LABEL: Record<ProcedureStepKind, string> = {
  instruction: 'Instruction',
  safety_check: 'Safety check',
  photo_required: 'Photo required',
  measurement_required: 'Measurement',
};

export function SnippetPickerModal({
  open,
  onClose,
  onPick,
  // Kept on Props for parity with the picker invocation but intentionally
  // unused — see comment on the load effect below for why.
  ownerOrganizationId: _ownerOrganizationId,
}: Props) {
  const [q, setQ] = useState('');
  const [snippets, setSnippets] = useState<AdminSnippet[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load on open; refetch when the search query changes (debounced).
  // Note: we deliberately don't pass ownerOrganizationId. The server's
  // scope filter already includes platform snippets and every org in
  // the caller's scope. Passing the doc's own org as a hard filter
  // would EXCLUDE platform snippets (ownerOrganizationId IS NULL),
  // which was the symptom of "No snippets found" right after creating
  // a snippet.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const rows = await listAdminSnippets({
          q: q.trim() || undefined,
          includePlatform: true,
          limit: 100,
        });
        if (!cancelled) {
          setSnippets(rows);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, q]);

  // Reset query when reopening so the picker starts fresh each time.
  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  // Esc closes the modal.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { platformList, orgList } = useMemo(() => {
    const list = snippets ?? [];
    return {
      platformList: list.filter((s) => s.isPlatform),
      orgList: list.filter((s) => !s.isPlatform),
    };
  }, [snippets]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="snippet-picker-title"
      >
        <header className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
          <div>
            <h2
              id="snippet-picker-title"
              className="text-sm font-semibold text-ink-primary"
            >
              Insert snippet
            </h2>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              Reusable step content. Edits to a snippet propagate to every
              attached step.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-tertiary hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Close picker"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="border-b border-line-subtle px-4 py-2">
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5">
            <Search className="size-3.5 text-ink-tertiary" />
            <input
              autoFocus
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search snippets by title…"
              className="w-full bg-transparent text-sm text-ink-primary outline-none placeholder:text-ink-tertiary"
            />
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {err && (
            <div className="px-4 py-3 text-sm text-signal-fault">{err}</div>
          )}
          {!err && loading && !snippets && (
            <div className="px-4 py-6 text-center text-sm text-ink-tertiary">
              Loading…
            </div>
          )}
          {!err && snippets && snippets.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-ink-secondary">No snippets found.</p>
              <p className="mt-1 text-xs text-ink-tertiary">
                Try a different search, or create one in Snippets.
              </p>
            </div>
          )}
          {!err && snippets && (
            <>
              {platformList.length > 0 && (
                <Section
                  title="Platform — global"
                  icon={<Globe2 className="size-3.5 text-accent" />}
                  snippets={platformList}
                  onPick={(s) => {
                    onPick(s);
                    onClose();
                  }}
                />
              )}
              {orgList.length > 0 && (
                <Section
                  title="Your organization"
                  icon={null}
                  snippets={orgList}
                  onPick={(s) => {
                    onPick(s);
                    onClose();
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  snippets,
  onPick,
}: {
  title: string;
  icon: React.ReactNode;
  snippets: AdminSnippet[];
  onPick: (s: AdminSnippet) => void;
}) {
  return (
    <div className="border-b border-line-subtle last:border-b-0">
      <div className="flex items-center gap-1.5 bg-surface px-4 py-1.5">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          {title}
        </span>
      </div>
      <ul className="divide-y divide-line-subtle">
        {snippets.map((s) => {
          const Icon = KIND_ICON[s.kind];
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition hover:bg-surface-elevated"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-ink-tertiary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-primary">
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-tertiary">
                    {KIND_LABEL[s.kind]}
                    {s.tags.length > 0 ? ` · ${s.tags.slice(0, 3).join(', ')}` : ''}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
