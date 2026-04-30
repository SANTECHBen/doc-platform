'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, FileText, Link2, RefreshCw } from 'lucide-react';
import { PageHeader, PageShell, Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import { ErrorBanner, SecondaryButton } from '@/components/form';
import {
  getAdminDocument,
  listSectionsForDocument,
  revalidateDocumentSections,
  type AdminDocumentDetail,
  type AdminDocumentSection,
} from '@/lib/api';
import { SectionsTab } from './sections-tab';
import { LinkedPartsTab } from './linked-parts-tab';

type Tab = 'overview' | 'sections' | 'linked-parts';

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
    tabParam === 'sections' || tabParam === 'linked-parts' ? tabParam : 'overview';

  const [doc, setDoc] = useState<AdminDocumentDetail | null>(null);
  const [sections, setSections] = useState<AdminDocumentSection[] | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [revalBusy, setRevalBusy] = useState(false);
  const toast = useToast();

  async function refresh() {
    try {
      const [d, s] = await Promise.all([
        getAdminDocument(id),
        listSectionsForDocument(id),
      ]);
      setDoc(d);
      setSections(s);
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

  if (!doc) {
    return (
      <PageShell crumbs={[{ label: 'Content packs', href: '/content-packs' }, { label: 'Document' }]}>
        {error ? <ErrorBanner error={error} /> : <p className="text-sm text-ink-tertiary">Loading…</p>}
      </PageShell>
    );
  }

  const isPublished = doc.contentPackVersionStatus !== 'draft';

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
            {doc.safetyCritical && <Pill tone="warning">safety-critical</Pill>}
            {doc.extractionStatus !== 'ready' && (
              <Pill tone={doc.extractionStatus === 'failed' ? 'danger' : 'info'}>
                extraction: {doc.extractionStatus}
              </Pill>
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
            <SecondaryButton
              type="button"
              onClick={onRevalidate}
              disabled={revalBusy || (sections ?? []).length === 0}
            >
              <RefreshCw className={`size-4 ${revalBusy ? 'animate-spin' : ''}`} />
              Re-validate sections
            </SecondaryButton>
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
