'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  ErrorBanner,
  FullPageOverlay,
  PrimaryButton,
  SecondaryButton,
} from '@/components/form';
import { Pill } from '@/components/page-shell';
import { useToast } from '@/components/toast';
import {
  createSection,
  deleteSection,
  listPartsForSection,
  setPartsForSection,
  updateSection,
  type AdminDocumentDetail,
  type AdminDocumentSection,
  type CreateSectionInput,
  type DocumentSectionKind,
} from '@/lib/api';
import { SectionForm } from '@/components/section-editor/section-form';

// Map document.kind → which section kinds make sense for it.
function allowedSectionKinds(docKind: AdminDocumentDetail['kind']): DocumentSectionKind[] {
  switch (docKind) {
    case 'pdf':
      return ['page_range', 'text_range'];
    case 'schematic':
    case 'slides':
      return ['page_range'];
    case 'markdown':
    case 'structured_procedure':
      return ['text_range'];
    case 'video':
    case 'external_video':
      return ['time_range'];
    case 'file':
      return [];
  }
}

export function SectionsTab({
  doc,
  sections,
  isPublished,
  onChanged,
}: {
  doc: AdminDocumentDetail;
  sections: AdminDocumentSection[];
  isPublished: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<AdminDocumentSection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const allowedKinds = useMemo(() => allowedSectionKinds(doc.kind), [doc.kind]);

  function openCreate() {
    setEditing(null);
    setDrawerOpen(true);
  }

  function openEdit(s: AdminDocumentSection) {
    setEditing(s);
    setDrawerOpen(true);
  }

  async function onSave(input: CreateSectionInput, partIds: string[]) {
    try {
      const saved = editing
        ? await updateSection(editing.id, input)
        : await createSection(doc.id, input);
      await setPartsForSection(saved.id, partIds);
      toast.success(editing ? 'Section updated' : 'Section created');
      setDrawerOpen(false);
      setEditing(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete(s: AdminDocumentSection) {
    if (!confirm(`Delete section "${s.title}"? This cannot be undone.`)) return;
    try {
      await deleteSection(s.id);
      toast.success('Section deleted');
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (allowedKinds.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line bg-surface-raised p-8 text-center text-sm text-ink-tertiary">
        Sections aren't supported for documents of kind <strong>{doc.kind}</strong>.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />

      {isPublished && (
        <div className="flex items-start gap-3 rounded-md border border-signal-warn/40 bg-signal-warn/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-signal-warn" />
          <div className="flex-1">
            <p className="font-medium text-signal-warn">
              This content pack version is published — sections are read-only.
            </p>
            <p className="mt-0.5 text-ink-secondary">
              Open <Link href={`/content-packs/${doc.contentPackId}`} className="underline">
              {doc.contentPackName}</Link> and click <strong>New draft version</strong> to
              author sections. Existing sections stay attached to v
              {doc.contentPackVersionNumber}.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          Sections are admin-authored anchors on this document. Each section can be linked
          to one or more parts; technicians scanning a part QR see only its linked sections.
        </p>
        {!isPublished && (
          <PrimaryButton type="button" onClick={openCreate}>
            <Plus className="size-4" /> Add section
          </PrimaryButton>
        )}
      </div>

      {sections.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line bg-surface-raised p-12 text-center">
          <p className="text-base font-semibold text-ink-primary">No sections yet</p>
          <p className="max-w-md text-sm text-ink-tertiary">
            Sections are anchors on this document — a page range, a text excerpt, or a
            video time range — that you link to specific parts. When a tech scans a part
            QR, only its linked sections render.
          </p>
          {!isPublished && (
            <PrimaryButton type="button" onClick={openCreate} className="mt-2">
              <Plus className="size-4" /> Add your first section
            </PrimaryButton>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {sections.map((s) => (
            <SectionRow
              key={s.id}
              section={s}
              isPublished={isPublished}
              onEdit={() => openEdit(s)}
              onDelete={() => onDelete(s)}
            />
          ))}
        </ul>
      )}

      <FullPageOverlay
        title={editing ? `Edit section — ${editing.title}` : 'New section'}
        subtitle={`${doc.title} · ${doc.kind.replace(/_/g, ' ')}`}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditing(null);
        }}
      >
        <SectionForm
          doc={doc}
          allowedKinds={allowedKinds}
          editing={editing}
          onSave={onSave}
          onCancel={() => {
            setDrawerOpen(false);
            setEditing(null);
          }}
        />
      </FullPageOverlay>
    </div>
  );
}

function SectionRow({
  section,
  isPublished,
  onEdit,
  onDelete,
}: {
  section: AdminDocumentSection;
  isPublished: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="rounded-md border border-line-subtle bg-surface-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium text-ink-primary">{section.title}</p>
            {section.safetyCritical && <Pill tone="warning">safety-critical</Pill>}
            {section.needsRevalidation && (
              <span className="inline-flex items-center gap-1 rounded-full bg-signal-warn/10 px-2 py-0.5 text-xs text-signal-warn">
                <AlertTriangle className="size-3" /> needs review
              </span>
            )}
          </div>
          <p className="mt-1 text-xs font-mono text-ink-tertiary">
            {sectionAnchorSummary(section)}
          </p>
          {section.description && (
            <p className="mt-2 text-sm text-ink-secondary">{section.description}</p>
          )}
          {section.needsRevalidation && section.revalidationReason && (
            <p className="mt-2 rounded bg-signal-warn/5 px-2 py-1 text-xs text-signal-warn/90">
              {section.revalidationReason}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isPublished && (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="rounded p-1.5 text-ink-tertiary hover:bg-surface hover:text-ink-primary"
                aria-label="Edit"
              >
                <Pencil className="size-4" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded p-1.5 text-ink-tertiary hover:bg-signal-fault/10 hover:text-signal-fault"
                aria-label="Delete"
              >
                <Trash2 className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function sectionAnchorSummary(s: AdminDocumentSection): string {
  if (s.kind === 'page_range') {
    if (s.pageStart === s.pageEnd) return `Page ${s.pageStart}`;
    return `Pages ${s.pageStart}–${s.pageEnd}`;
  }
  if (s.kind === 'text_range') {
    const excerpt = (s.anchorExcerpt ?? '').slice(0, 80);
    const more = (s.anchorExcerpt ?? '').length > 80 ? '…' : '';
    const where = s.textPageHint ? ` (page ${s.textPageHint})` : '';
    return `Text "${excerpt}${more}"${where}`;
  }
  // time_range
  const fmt = (sec: number | null): string => {
    if (sec == null) return '?';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const sLeft = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sLeft).padStart(2, '0')}`
      : `${m}:${String(sLeft).padStart(2, '0')}`;
  };
  return `Time ${fmt(s.timeStartSeconds)}–${fmt(s.timeEndSeconds)}`;
}
