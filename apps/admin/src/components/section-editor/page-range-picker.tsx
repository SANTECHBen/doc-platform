'use client';

import { Field, TextInput } from '@/components/form';
import type { AdminDocumentDetail } from '@/lib/api';

// Page range picker — numeric inputs for start/end pages. The PDF preview
// (when available) is shown alongside so the admin can visually confirm
// pages before saving. The fancier drag-select-on-thumbnails picker is a
// follow-up enhancement.
export function PageRangePicker({
  doc,
  pageStart,
  pageEnd,
  onChange,
}: {
  doc: AdminDocumentDetail;
  pageStart: number;
  pageEnd: number;
  onChange: (start: number, end: number) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-2 gap-4">
        <Field label="From page" required>
          <TextInput
            type="number"
            min={1}
            value={pageStart}
            onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1), pageEnd)}
            required
          />
        </Field>
        <Field label="To page" required>
          <TextInput
            type="number"
            min={pageStart}
            value={pageEnd}
            onChange={(e) =>
              onChange(pageStart, Math.max(pageStart, Number(e.target.value) || pageStart))
            }
            required
          />
        </Field>
      </div>
      {doc.fileUrl && doc.kind === 'pdf' && (
        <div className="flex min-h-0 flex-1 flex-col rounded border border-line-subtle bg-surface">
          <iframe
            src={`${doc.fileUrl}#page=${pageStart}`}
            title={`${doc.title} preview`}
            className="min-h-[480px] flex-1 w-full rounded bg-white"
          />
          <p className="border-t border-line-subtle px-3 py-1.5 text-xs text-ink-tertiary">
            Preview opens to page {pageStart}. Verify pages {pageStart}–{pageEnd} render the
            content you want before saving.
          </p>
        </div>
      )}
    </div>
  );
}
