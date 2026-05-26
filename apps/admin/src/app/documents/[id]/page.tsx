'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  FileText,
  Link2,
  ListChecks,
  Presentation,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import { ErrorBanner, PrimaryButton, SecondaryButton } from '@/components/form';
import {
  getAdminDocument,
  listProcedureSections,
  listProcedureSteps,
  listSectionsForDocument,
  revalidateDocumentSections,
  updateAdminDocument,
  verifyFieldDocument,
  type AdminDocumentDetail,
  type AdminDocumentSection,
  type AdminProcedureSection,
  type AdminProcedureStep,
} from '@/lib/api';
import { SectionsTab } from './sections-tab';
import { LinkedPartsTab } from './linked-parts-tab';
import { ProcedureCmsEditor } from '@/components/procedure-cms/procedure-cms-editor';

type Tab = 'overview' | 'sections' | 'linked-parts' | 'steps';

export default function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = use(params);
  const { tab: tabParam } = use(searchParams);
  const initialTab: Tab =
    tabParam === 'sections' ||
    tabParam === 'linked-parts' ||
    tabParam === 'steps'
      ? tabParam
      : 'overview';

  const [doc, setDoc] = useState<AdminDocumentDetail | null>(null);
  const [sections, setSections] = useState<AdminDocumentSection[] | null>(null);
  const [steps, setSteps] = useState<AdminProcedureStep[] | null>(null);
  // Procedure sections — distinct from doc sections above. Used by the
  // sectioned procedure CMS editor on the "steps" tab.
  const [procedureSections, setProcedureSections] = useState<AdminProcedureSection[]>([]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [revalBusy, setRevalBusy] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      // Fetch the doc first so we know whether to load procedure steps. For
      // every other doc kind, the steps endpoint would 400 / be irrelevant.
      const d = await getAdminDocument(id);
      const isProcedure = d.kind === 'structured_procedure';
      const [s, st, psecs] = await Promise.all([
        listSectionsForDocument(id),
        isProcedure ? listProcedureSteps(id) : Promise.resolve(null),
        isProcedure ? listProcedureSections(id) : Promise.resolve([]),
      ]);
      setDoc(d);
      setSections(s);
      setSteps(st);
      setProcedureSections(psecs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const flaggedCount = useMemo(
    () => (sections ?? []).filter((s) => s.needsRevalidation).length,
    [sections],
  );

  async function onRevalidate() {
    if (revalBusy) return;
    setRevalBusy(true);
    try {
      const r = await revalidateDocumentSections(id);
      toast.success(
        'Re-validation complete',
        `${r.total} sections — ${r.accepted} accepted, ${r.flagged} flagged.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevalBusy(false);
    }
  }

  const [verifyBusy, setVerifyBusy] = useState(false);
  async function onPromote() {
    if (verifyBusy) return;
    setVerifyBusy(true);
    try {
      await verifyFieldDocument(id);
      toast.success('Promoted to verified', 'Field-captured procedure is now verified.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifyBusy(false);
    }
  }

  if (!doc) {
    return (
      <PageShell crumbs={[{ label: 'Content packs', href: '/content-packs' }, { label: 'Document' }]}>
        {error ? <ErrorBanner error={error} /> : <p className="text-sm text-ink-tertiary">Loading…</p>}
      </PageShell>
    );
  }

  const isPublished = doc.contentPackVersionStatus !== 'draft';
  const isFieldCaptured = doc.contentPackKind === 'field_captures';
  const isVerified = doc.fieldVerifiedAt !== null;

  const crumbs = [
    { label: 'Content packs', href: '/content-packs' },
    {
      label: `${doc.contentPackName} — v${doc.contentPackVersionNumber}`,
      href: `/content-packs/${doc.contentPackId}`,
    },
    { label: doc.title },
  ];

  return (
    <PageShell crumbs={crumbs}>
      <PageHeader
        title={doc.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone={isPublished ? 'success' : 'default'}>
              {doc.contentPackVersionStatus}
            </Pill>
            <Pill>{doc.kind.replace(/_/g, ' ')}</Pill>
            {isFieldCaptured && (
              <Pill tone={isVerified ? 'success' : 'warning'}>
                {isVerified ? 'verified · field' : 'unverified · field'}
              </Pill>
            )}
            {doc.safetyCritical && <Pill tone="warning">safety-critical</Pill>}
            {/* AI knowledge toggle — pill doubles as status + quick action.
                Off = chunks excluded from chat retriever; on = searchable. */}
            <AiIndexedPill doc={doc} onChanged={refresh} />
            {/* "Used by N PMs" — only renders when at least one PM schedule
                references this procedure. Hover to see all referencing
                schedules; click to jump to the first one's asset model. */}
            {doc.pmScheduleRefs.length > 0 && (
              <PmScheduleRefsPill refs={doc.pmScheduleRefs} />
            )}
            {doc.extractionStatus !== 'ready' && doc.extractionStatus !== 'not_applicable' && (
              <Pill tone={doc.extractionStatus === 'failed' ? 'danger' : 'info'}>
                extraction: {doc.extractionStatus}
              </Pill>
            )}
            {isVerified && doc.fieldVerifiedByDisplayName && (
              <span className="text-xs text-ink-tertiary">
                Verified by {doc.fieldVerifiedByDisplayName}
                {doc.fieldVerifiedAt
                  ? ` on ${new Date(doc.fieldVerifiedAt).toLocaleDateString()}`
                  : ''}
              </span>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/content-packs/${doc.contentPackId}`}>
              <SecondaryButton type="button">
                <ArrowLeft className="size-4" /> Back to pack
              </SecondaryButton>
            </Link>
            {isFieldCaptured && !isVerified && (
              <PrimaryButton type="button" onClick={onPromote} disabled={verifyBusy}>
                <ShieldCheck className="size-4" />
                {verifyBusy ? 'Promoting…' : 'Promote to verified'}
              </PrimaryButton>
            )}
            {!isFieldCaptured && (
              <SecondaryButton
                type="button"
                onClick={onRevalidate}
                disabled={revalBusy || (sections ?? []).length === 0}
              >
                <RefreshCw className={`size-4 ${revalBusy ? 'animate-spin' : ''}`} />
                Re-validate sections
              </SecondaryButton>
            )}
            {doc.kind === 'slides' && (
              // PPTX uploads become a slide course on conversion. The
              // editor lives at its own route because the 3-pane layout
              // doesn't fit inside this page's tab strip.
              <Link href={`/documents/${id}/course`}>
                <PrimaryButton type="button">
                  <Presentation className="size-4" /> Open course editor
                </PrimaryButton>
              </Link>
            )}
          </div>
        }
      />

      <ErrorBanner error={error} />

      {flaggedCount > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-md border border-signal-warn/40 bg-signal-warn/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-signal-warn" />
          <div>
            <p className="font-medium text-signal-warn">
              {flaggedCount} section{flaggedCount === 1 ? '' : 's'} need re-validation
            </p>
            <p className="mt-0.5 text-ink-secondary">
              The document content drifted enough that the original anchors may be stale.
              Open each flagged section, confirm or re-pick the anchor, and save.
            </p>
          </div>
        </div>
      )}

      <nav className="mb-6 flex gap-2 border-b border-line">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
          <FileText className="size-4" /> Overview
        </TabButton>
        <TabButton active={tab === 'sections'} onClick={() => setTab('sections')}>
          Sections{sections ? ` (${sections.length})` : ''}
        </TabButton>
        <TabButton active={tab === 'linked-parts'} onClick={() => setTab('linked-parts')}>
          <Link2 className="size-4" /> Linked parts
        </TabButton>
        {doc.kind === 'structured_procedure' && (
          <TabButton active={tab === 'steps'} onClick={() => setTab('steps')}>
            <ListChecks className="size-4" /> Steps{steps ? ` (${steps.length})` : ''}
          </TabButton>
        )}
      </nav>

      {tab === 'overview' && <OverviewTab doc={doc} sectionCount={sections?.length ?? 0} />}
      {tab === 'sections' && (
        <SectionsTab
          doc={doc}
          sections={sections ?? []}
          isPublished={isPublished}
          onChanged={refresh}
        />
      )}
      {tab === 'linked-parts' && <LinkedPartsTab documentId={doc.id} />}
      {tab === 'steps' && doc.kind === 'structured_procedure' && (
        <ProcedureCmsEditor
          doc={doc}
          steps={steps ?? []}
          sections={procedureSections}
          onChanged={refresh}
        />
      )}
    </PageShell>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${
        active
          ? 'border-accent text-ink-primary'
          : 'border-transparent text-ink-tertiary hover:text-ink-primary'
      }`}
    >
      {children}
    </button>
  );
}

function OverviewTab({
  doc,
  sectionCount,
}: {
  doc: AdminDocumentDetail;
  sectionCount: number;
}) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Title', value: doc.title },
    { label: 'Kind', value: doc.kind.replace(/_/g, ' ') },
    { label: 'Content type', value: doc.contentType },
    {
      label: 'Original filename',
      value: doc.originalFilename ?? <span className="text-ink-tertiary">—</span>,
    },
    {
      label: 'Size',
      value:
        doc.sizeBytes != null
          ? `${(doc.sizeBytes / 1024 / 1024).toFixed(2)} MB`
          : <span className="text-ink-tertiary">—</span>,
    },
    {
      label: 'Language',
      value: doc.language ?? <span className="text-ink-tertiary">—</span>,
    },
    { label: 'Sections', value: String(sectionCount) },
    { label: 'Extraction status', value: doc.extractionStatus },
    {
      label: 'Last extracted',
      value: doc.extractedAt
        ? new Date(doc.extractedAt).toLocaleString()
        : <span className="text-ink-tertiary">—</span>,
    },
    {
      label: 'Belongs to',
      value: (
        <Link
          className="text-accent hover:underline"
          href={`/content-packs/${doc.contentPackId}`}
        >
          {doc.contentPackName} — v{doc.contentPackVersionNumber}
        </Link>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="overflow-hidden rounded-md border border-line-subtle bg-surface-raised">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line-subtle">
              {rows.map((r) => (
                <tr key={r.label}>
                  <th className="w-44 bg-surface px-4 py-2.5 text-left font-medium text-ink-secondary">
                    {r.label}
                  </th>
                  <td className="px-4 py-2.5 text-ink-primary">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {doc.extractionError && (
          <div className="mt-4 rounded-md border border-signal-fault/40 bg-signal-fault/10 p-3 text-xs text-signal-fault">
            <p className="font-medium">Extraction error</p>
            <pre className="mt-1 whitespace-pre-wrap font-mono">{doc.extractionError}</pre>
          </div>
        )}
      </div>
      <div className="lg:col-span-1">
        {doc.thumbnailUrl ? (
          <img
            src={doc.thumbnailUrl}
            alt=""
            className="rounded-md border border-line-subtle"
          />
        ) : doc.fileUrl && doc.kind === 'pdf' ? (
          <iframe
            src={doc.fileUrl}
            className="h-[600px] w-full rounded-md border border-line-subtle bg-white"
            title={doc.title}
          />
        ) : (
          <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-line bg-surface-raised text-sm text-ink-tertiary">
            No preview available
          </div>
        )}
      </div>
    </div>
  );
}

// "Used by N PMs" pill — surfaces the reverse linkage so an admin
// looking at a procedure knows whether it's library-only or wired into
// PM schedules. Click jumps to the first referencing schedule's asset
// model PM section (anchored via #pm-section in the asset-model page).
function PmScheduleRefsPill({
  refs,
}: {
  refs: AdminDocumentDetail['pmScheduleRefs'];
}) {
  const first = refs[0];
  if (!first) return null;
  const href = `/asset-models/${encodeURIComponent(first.assetModelId)}#pm-section`;
  const title = `Used by ${refs.length} PM schedule${refs.length === 1 ? '' : 's'}:\n` +
    refs.map((r) => `• ${r.assetModelDisplayName}: ${r.name}`).join('\n');
  return (
    <Link
      href={href}
      title={title}
      className="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand transition hover:bg-brand/15"
    >
      <CalendarClock className="size-3" />
      {refs.length} PM{refs.length === 1 ? '' : 's'}
    </Link>
  );
}

// AI-knowledge pill — shown next to the safety + extraction pills in the
// document header. Click to toggle. On = chat retriever can quote this
// doc; off = chunks excluded (and existing chunks are cleared server-side
// so the change takes effect immediately, not after the next ingest).
function AiIndexedPill({
  doc,
  onChanged,
}: {
  doc: AdminDocumentDetail;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function toggle() {
    setBusy(true);
    try {
      const next = !doc.aiIndexed;
      await updateAdminDocument(doc.id, { aiIndexed: next });
      toast.success(
        next ? 'Included in AI knowledge' : 'Hidden from AI',
        next
          ? 'The chat retriever can now search and quote this doc.'
          : 'Existing chunks were cleared. Reprocess to re-index after toggling back on.',
      );
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={
        doc.aiIndexed
          ? 'In AI knowledge — chat can quote this doc. Click to exclude.'
          : 'Hidden from AI — chat ignores this doc. Click to include.'
      }
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition',
        doc.aiIndexed
          ? 'border border-accent/40 bg-accent/10 text-accent hover:bg-accent/15'
          : 'border border-line bg-surface text-ink-tertiary hover:bg-surface-elevated',
        busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      ].join(' ')}
    >
      AI {doc.aiIndexed ? 'on' : 'off'}
    </button>
  );
}
