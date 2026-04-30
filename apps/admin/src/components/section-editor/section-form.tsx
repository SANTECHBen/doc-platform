'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Field,
  PrimaryButton,
  SecondaryButton,
  Select,
  TextInput,
  Textarea,
  ErrorBanner,
} from '@/components/form';
import {
  listAdminParts,
  listPartsForSection,
  type AdminDocumentDetail,
  type AdminDocumentSection,
  type AdminPart,
  type CreateSectionInput,
  type DocumentSectionKind,
} from '@/lib/api';
import { PageRangePicker } from './page-range-picker';
import { TextRangePicker } from './text-range-picker';
import { TimeRangePicker } from './time-range-picker';
import { PartsPicker } from './parts-picker';

export function SectionForm({
  doc,
  allowedKinds,
  editing,
  onSave,
  onCancel,
}: {
  doc: AdminDocumentDetail;
  allowedKinds: DocumentSectionKind[];
  editing: AdminDocumentSection | null;
  onSave: (input: CreateSectionInput, partIds: string[]) => Promise<void> | void;
  onCancel: () => void;
}) {
  const initialKind: DocumentSectionKind =
    editing?.kind ?? allowedKinds[0] ?? 'page_range';

  const [kind, setKind] = useState<DocumentSectionKind>(initialKind);
  const [title, setTitle] = useState(editing?.title ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [safetyCritical, setSafetyCritical] = useState(editing?.safetyCritical ?? false);
  const [orderingHint, setOrderingHint] = useState<number>(editing?.orderingHint ?? 0);

  const [pageStart, setPageStart] = useState<number>(editing?.pageStart ?? 1);
  const [pageEnd, setPageEnd] = useState<number>(editing?.pageEnd ?? 1);

  const [anchorExcerpt, setAnchorExcerpt] = useState(editing?.anchorExcerpt ?? '');
  const [anchorContextBefore, setAnchorContextBefore] = useState(
    editing?.anchorContextBefore ?? '',
  );
  const [anchorContextAfter, setAnchorContextAfter] = useState(
    editing?.anchorContextAfter ?? '',
  );
  const [textPageHint, setTextPageHint] = useState<number | null>(
    editing?.textPageHint ?? null,
  );

  const [timeStart, setTimeStart] = useState<number>(editing?.timeStartSeconds ?? 0);
  const [timeEnd, setTimeEnd] = useState<number>(editing?.timeEndSeconds ?? 30);

  const [allParts, setAllParts] = useState<AdminPart[] | null>(null);
  const [linkedPartIds, setLinkedPartIds] = useState<Set<string>>(new Set());

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load parts list + (if editing) the section's currently-linked parts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [parts, linked] = await Promise.all([
          listAdminParts(),
          editing ? listPartsForSection(editing.id) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setAllParts(parts);
        setLinkedPartIds(new Set(linked.map((l) => l.partId)));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing?.id]);

  function buildInput(): CreateSectionInput | null {
    if (!title.trim()) {
      setError('Title is required.');
      return null;
    }
    const common = {
      title: title.trim(),
      description: description.trim() || null,
      safetyCritical,
      orderingHint,
    };
    if (kind === 'page_range') {
      if (pageStart < 1 || pageEnd < pageStart) {
        setError('pageStart must be >= 1 and pageEnd must be >= pageStart.');
        return null;
      }
      return { kind: 'page_range', ...common, pageStart, pageEnd };
    }
    if (kind === 'text_range') {
      if (!anchorExcerpt.trim()) {
        setError('Excerpt is required for text-range sections.');
        return null;
      }
      return {
        kind: 'text_range',
        ...common,
        anchorExcerpt: anchorExcerpt,
        anchorContextBefore: anchorContextBefore || null,
        anchorContextAfter: anchorContextAfter || null,
        textPageHint: textPageHint ?? null,
      };
    }
    if (kind === 'time_range') {
      if (timeStart < 0 || timeEnd <= timeStart) {
        setError('timeStart must be >= 0 and timeEnd must be > timeStart.');
        return null;
      }
      return { kind: 'time_range', ...common, timeStartSeconds: timeStart, timeEndSeconds: timeEnd };
    }
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    try {
      await onSave(input, [...linkedPartIds]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <ErrorBanner error={error} />

      {!editing && allowedKinds.length > 1 && (
        <Field label="Section type" required>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentSectionKind)}
          >
            {allowedKinds.includes('page_range') && (
              <option value="page_range">Page range</option>
            )}
            {allowedKinds.includes('text_range') && (
              <option value="text_range">Text excerpt</option>
            )}
            {allowedKinds.includes('time_range') && (
              <option value="time_range">Time range</option>
            )}
          </Select>
        </Field>
      )}

      <Field label="Title" required>
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Flight Removal procedure"
          required
        />
      </Field>

      <Field label="Description" hint="Optional context shown to the technician.">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </Field>

      {kind === 'page_range' && (
        <PageRangePicker
          doc={doc}
          pageStart={pageStart}
          pageEnd={pageEnd}
          onChange={(s, e) => {
            setPageStart(s);
            setPageEnd(e);
          }}
        />
      )}
      {kind === 'text_range' && (
        <TextRangePicker
          doc={doc}
          anchorExcerpt={anchorExcerpt}
          anchorContextBefore={anchorContextBefore}
          anchorContextAfter={anchorContextAfter}
          textPageHint={textPageHint}
          onChange={(v) => {
            setAnchorExcerpt(v.excerpt);
            setAnchorContextBefore(v.contextBefore);
            setAnchorContextAfter(v.contextAfter);
            setTextPageHint(v.pageHint);
          }}
        />
      )}
      {kind === 'time_range' && (
        <TimeRangePicker
          doc={doc}
          startSeconds={timeStart}
          endSeconds={timeEnd}
          onChange={(s, e) => {
            setTimeStart(s);
            setTimeEnd(e);
          }}
        />
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Ordering hint" hint="Lower numbers render first.">
          <TextInput
            type="number"
            value={orderingHint}
            onChange={(e) => setOrderingHint(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="Safety">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={safetyCritical}
              onChange={(e) => setSafetyCritical(e.target.checked)}
            />
            Safety-critical
          </label>
        </Field>
      </div>

      <div className="border-t border-line pt-4">
        <h3 className="mb-3 text-sm font-medium text-ink-primary">Linked parts</h3>
        {allParts ? (
          <PartsPicker
            allParts={allParts}
            selected={linkedPartIds}
            onChange={setLinkedPartIds}
          />
        ) : (
          <p className="text-sm text-ink-tertiary">Loading parts…</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <SecondaryButton type="button" onClick={onCancel}>
          Cancel
        </SecondaryButton>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create section'}
        </PrimaryButton>
      </div>
    </form>
  );
}
