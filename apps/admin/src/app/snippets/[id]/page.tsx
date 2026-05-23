'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Globe2,
  History,
  Loader2,
  Puzzle,
  ScrollText,
  Trash2,
} from 'lucide-react';
import { BlockListEditor } from '@/components/procedure-cms/block-editor';
import { useToast } from '@/components/toast';
import { PageHeader, PageShell } from '@/components/page-shell';
import {
  ErrorBanner,
  GhostButton,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
} from '@/components/form';
import {
  deleteAdminSnippet,
  getAdminSnippet,
  listSnippetRevisions,
  updateAdminSnippet,
  type AdminSnippetDetail,
  type AdminSnippetRevision,
  type ProcedureStepKind,
  type StepBlock,
} from '@/lib/api';

export default function SnippetEditPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const id = params.id;

  const [snippet, setSnippet] = useState<AdminSnippetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ProcedureStepKind>('instruction');
  const [blocks, setBlocks] = useState<StepBlock[]>([]);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<AdminSnippetRevision[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocksTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    try {
      const detail = await getAdminSnippet(id);
      setSnippet(detail);
      setTitle(detail.title);
      setKind(detail.kind);
      setBlocks(detail.blocks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function flushPatch(
    patch: Partial<{ title: string; kind: ProcedureStepKind; blocks: StepBlock[] }>,
  ) {
    if (!snippet) return;
    setSaveStatus('saving');
    try {
      const next = await updateAdminSnippet(snippet.id, patch);
      setSnippet(next);
      setSaveStatus('saved');
      setTimeout(() => {
        setSaveStatus((cur) => (cur === 'saved' ? 'idle' : cur));
      }, 1500);
      // If history is open, refresh it so the new revision appears.
      if (showHistory) {
        try {
          setRevisions(await listSnippetRevisions(snippet.id));
        } catch {
          // non-fatal — history can stay stale until the user reopens.
        }
      }
    } catch (e) {
      setSaveStatus('error');
      toast.error('Save failed', e instanceof Error ? e.message : String(e));
    }
  }

  function onTitleChange(next: string) {
    setTitle(next);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      const v = next.trim();
      if (v && snippet && v !== snippet.title) {
        void flushPatch({ title: v });
      }
    }, 600);
  }

  function onBlocksChange(next: StepBlock[]) {
    setBlocks(next);
    if (blocksTimer.current) clearTimeout(blocksTimer.current);
    blocksTimer.current = setTimeout(() => {
      void flushPatch({ blocks: next });
    }, 800);
  }

  function onKindChange(next: ProcedureStepKind) {
    setKind(next);
    void flushPatch({ kind: next });
  }

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    if (!snippet) return;
    setShowHistory(true);
    try {
      setRevisions(await listSnippetRevisions(snippet.id));
    } catch (e) {
      toast.error('Load history failed', e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete() {
    if (!snippet) return;
    if (
      !confirm(
        `Delete snippet "${snippet.title}"?${
          snippet.referenceCount > 0
            ? `\n\nIt is referenced by ${snippet.referenceCount} active step${
                snippet.referenceCount === 1 ? '' : 's'
              } — those references must be detached first.`
            : ''
        }`,
      )
    ) {
      return;
    }
    setDeleteBusy(true);
    try {
      const res = await deleteAdminSnippet(snippet.id);
      if ('statusCode' in res && res.statusCode === 409) {
        toast.error(
          'Cannot delete',
          `${res.references.length} procedure step${
            res.references.length === 1 ? '' : 's'
          } still reference this snippet.`,
        );
        // Refresh to update referenceCount in case it changed.
        await load();
      } else {
        toast.success('Deleted', 'Snippet removed.');
        router.push('/snippets');
      }
    } catch (e) {
      toast.error('Delete failed', e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <PageShell
      crumbs={[
        { label: 'Snippets', href: '/snippets' },
        { label: snippet?.title ?? 'Loading…' },
      ]}
    >
      <div className="mb-3">
        <Link
          href="/snippets"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-tertiary hover:text-ink-primary"
        >
          <ArrowLeft size={12} /> Back to snippets
        </Link>
      </div>
      <PageHeader
        title={snippet?.title ?? 'Loading…'}
        description={
          <span className="inline-flex items-center gap-2">
            {snippet?.isPlatform ? (
              <>
                <Globe2 size={14} className="text-accent" />
                <span>
                  Platform-tier snippet. Edits propagate to every organization that references it.
                </span>
              </>
            ) : snippet ? (
              <>
                <Puzzle size={14} className="text-ink-secondary" />
                <span>
                  Organization-scoped snippet. Edits propagate to every step in your org that references it.
                </span>
              </>
            ) : null}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <SaveStatusPill status={saveStatus} />
            <GhostButton onClick={() => void toggleHistory()}>
              <History size={14} /> History
            </GhostButton>
            <SecondaryButton
              onClick={() => void onDelete()}
              disabled={deleteBusy || !snippet}
            >
              <Trash2 size={14} /> Delete
            </SecondaryButton>
          </div>
        }
      />
      <ErrorBanner error={error} />
      {snippet?.isPlatform && (
        <PlatformPropagationCallout referenceCount={snippet.referenceCount} />
      )}
      {!snippet ? (
        <p className="rounded-md border border-line bg-surface px-4 py-8 text-center text-sm text-ink-tertiary">
          Loading snippet…
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <main className="flex flex-col gap-4">
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="w-full rounded-md border border-line bg-surface-raised px-3 py-2 text-2xl font-semibold text-ink-primary outline-none focus:border-accent"
              placeholder="Snippet title"
              maxLength={200}
            />
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span>Kind:</span>
              <Select
                value={kind}
                onChange={(e) => onKindChange(e.target.value as ProcedureStepKind)}
              >
                <option value="instruction">Instruction</option>
                <option value="safety_check">Safety check</option>
                <option value="photo_required">Photo required</option>
                <option value="measurement_required">Measurement</option>
              </Select>
            </div>
            <BlockListEditor
              blocks={blocks}
              onChange={onBlocksChange}
              // Snippets don't carry media — block-editor falls back gracefully
              // for the photo_inline block when stepMedia is empty.
              stepMedia={[]}
            />
            {showHistory && (
              <RevisionsPanel revisions={revisions} onClose={() => setShowHistory(false)} />
            )}
          </main>
          <aside className="flex flex-col gap-3">
            <ReferencesPanel snippet={snippet} />
          </aside>
        </div>
      )}
    </PageShell>
  );
}

function PlatformPropagationCallout({ referenceCount }: { referenceCount: number }) {
  if (referenceCount === 0) {
    return (
      <div className="mb-4 flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-ink-secondary">
        <Globe2 size={14} className="mt-0.5 text-accent" />
        <span>
          Platform snippet. Once a step references it, edits here propagate across every organization that uses it.
        </span>
      </div>
    );
  }
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-signal-warn/30 bg-signal-warn/5 px-3 py-2 text-xs text-ink-primary">
      <AlertTriangle size={14} className="mt-0.5 text-signal-warn" />
      <span>
        Platform snippet — currently used by{' '}
        <strong>{referenceCount}</strong> active step
        {referenceCount === 1 ? '' : 's'} across customer organizations. Saving an edit propagates to every reference; an audit event is recorded per affected org.
      </span>
    </div>
  );
}

function ReferencesPanel({ snippet }: { snippet: AdminSnippetDetail }) {
  return (
    <div className="rounded-md border border-line bg-surface-raised">
      <header className="border-b border-line-subtle px-3 py-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-tertiary">
          Used by {snippet.referenceCount} step
          {snippet.referenceCount === 1 ? '' : 's'}
        </h3>
      </header>
      {snippet.referencesPreview.length === 0 ? (
        <p className="px-3 py-3 text-xs text-ink-tertiary">
          No active references yet. Insert this snippet from any procedure step to start using it.
        </p>
      ) : (
        <ul className="divide-y divide-line-subtle text-xs">
          {snippet.referencesPreview.map((r) => (
            <li key={r.stepId} className="px-3 py-2">
              <Link
                href={`/documents/${r.documentId}`}
                className="block hover:underline"
              >
                <p className="truncate font-medium text-ink-primary">
                  {r.documentTitle}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-ink-tertiary">
                  Step: {r.stepTitle || '(untitled)'}
                </p>
              </Link>
            </li>
          ))}
          {snippet.referenceCount > snippet.referencesPreview.length && (
            <li className="px-3 py-2 text-[11px] text-ink-tertiary">
              + {snippet.referenceCount - snippet.referencesPreview.length} more…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function RevisionsPanel({
  revisions,
  onClose,
}: {
  revisions: AdminSnippetRevision[] | null;
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-raised">
      <header className="flex items-center justify-between border-b border-line-subtle px-3 py-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-primary">
          <ScrollText size={12} /> Revision history
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-ink-tertiary hover:text-ink-primary"
        >
          Close
        </button>
      </header>
      {!revisions ? (
        <p className="px-3 py-3 text-xs text-ink-tertiary">Loading…</p>
      ) : revisions.length === 0 ? (
        <p className="px-3 py-3 text-xs text-ink-tertiary">No revisions recorded.</p>
      ) : (
        <ol className="divide-y divide-line-subtle text-xs">
          {revisions.map((r) => (
            <li key={r.id} className="px-3 py-2">
              <p className="font-medium text-ink-primary">
                Revision {r.revisionNumber}
                <span className="ml-2 font-normal text-ink-tertiary">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </p>
              {r.changeNote && (
                <p className="mt-0.5 text-[11px] italic text-ink-secondary">
                  {r.changeNote}
                </p>
              )}
              <p className="mt-0.5 text-[11px] text-ink-tertiary">
                Title: {r.title}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SaveStatusPill({
  status,
}: {
  status: 'idle' | 'saving' | 'saved' | 'error';
}) {
  if (status === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent">
        <Loader2 className="size-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-ok/15 px-2.5 py-1 text-xs font-medium text-signal-ok">
        Saved
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-fault/15 px-2.5 py-1 text-xs font-medium text-signal-fault">
        Save failed
      </span>
    );
  }
  return null;
}
