'use client';

import { useState } from 'react';
import { Field, SecondaryButton, TextInput } from '@/components/form';
import type { AdminDocumentDetail } from '@/lib/api';

// Page range picker — numeric inputs for start/end pages plus an optional
// "Refine boundaries" panel for sub-page Y crops. Use Y crops when a
// procedure ends mid-page and the next one starts on the same page (so
// rendering full pages would bleed the next procedure's content).
//
// Y values are stored as 0..1 fractions where 0 = top of page, 1 = bottom.
// startY is the top crop on the FIRST page; endY is the bottom crop on
// the LAST page. Anything above startY on page_start is hidden in the
// PWA; anything below endY on page_end is hidden.
//
// When pageStart === pageEnd, both crops apply to the same page (so the
// admin can isolate a single procedure mid-page). Constraint enforced at
// the DB level requires startY < endY in that case.
export function PageRangePicker({
  doc,
  pageStart,
  pageEnd,
  startY,
  endY,
  onChange,
}: {
  doc: AdminDocumentDetail;
  pageStart: number;
  pageEnd: number;
  startY: number | null;
  endY: number | null;
  onChange: (v: {
    pageStart: number;
    pageEnd: number;
    startY: number | null;
    endY: number | null;
  }) => void;
}) {
  const [refineOpen, setRefineOpen] = useState(startY != null || endY != null);

  function update(patch: Partial<{
    pageStart: number;
    pageEnd: number;
    startY: number | null;
    endY: number | null;
  }>) {
    onChange({
      pageStart: patch.pageStart ?? pageStart,
      pageEnd: patch.pageEnd ?? pageEnd,
      startY: patch.startY === undefined ? startY : patch.startY,
      endY: patch.endY === undefined ? endY : patch.endY,
    });
  }

  const samePage = pageStart === pageEnd;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-2 gap-4">
        <Field label="From page" required>
          <TextInput
            type="number"
            min={1}
            value={pageStart}
            onChange={(e) =>
              update({ pageStart: Math.max(1, Number(e.target.value) || 1) })
            }
            required
          />
        </Field>
        <Field label="To page" required>
          <TextInput
            type="number"
            min={pageStart}
            value={pageEnd}
            onChange={(e) =>
              update({ pageEnd: Math.max(pageStart, Number(e.target.value) || pageStart) })
            }
            required
          />
        </Field>
      </div>

      <div className="rounded border border-line-subtle bg-surface p-3">
        <button
          type="button"
          onClick={() => setRefineOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left text-sm"
        >
          <span className="font-medium text-ink-primary">
            Refine boundaries (optional)
          </span>
          <span className="text-xs text-ink-tertiary">{refineOpen ? '▴' : '▾'}</span>
        </button>
        {!refineOpen && (
          <p className="mt-1 text-xs text-ink-tertiary">
            By default the section renders full pages. If a procedure ends mid-page (and
            the next one starts on the same page), open this to set fractional Y cuts on
            the first/last pages.
          </p>
        )}
        {refineOpen && (
          <div className="mt-3 flex flex-col gap-3">
            <YCropSlider
              label={`Start cut on page ${pageStart}`}
              hint={`Hide content above this line on page ${pageStart}. 0% = top, 100% = bottom.`}
              value={startY}
              defaultIfEnabled={0}
              onChange={(v) => update({ startY: v })}
            />
            <YCropSlider
              label={`End cut on page ${pageEnd}`}
              hint={`Hide content below this line on page ${pageEnd}. 0% = top, 100% = bottom.`}
              value={endY}
              defaultIfEnabled={1}
              onChange={(v) => update({ endY: v })}
            />
            {samePage && startY != null && endY != null && startY >= endY && (
              <p className="rounded border border-signal-warn/40 bg-signal-warn/10 px-2 py-1 text-xs text-signal-warn">
                Same page: start cut must be above end cut. Drag start cut up or end cut
                down.
              </p>
            )}
          </div>
        )}
      </div>

      {doc.fileUrl && doc.kind === 'pdf' && (
        <div className="flex min-h-0 flex-1 flex-col rounded border border-line-subtle bg-surface">
          <iframe
            src={`${doc.fileUrl}#page=${pageStart}`}
            title={`${doc.title} preview`}
            className="min-h-[480px] flex-1 w-full rounded bg-white"
          />
          <p className="border-t border-line-subtle px-3 py-1.5 text-xs text-ink-tertiary">
            Preview opens to page {pageStart}. Verify pages {pageStart}–{pageEnd} render
            the content you want before saving. Y crops aren't visualized here; they
            apply at PWA render time.
          </p>
        </div>
      )}
    </div>
  );
}

function YCropSlider({
  label,
  hint,
  value,
  defaultIfEnabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  defaultIfEnabled: number;
  onChange: (next: number | null) => void;
}) {
  const enabled = value != null;
  const pct = enabled ? Math.round(value * 100) : 0;
  return (
    <div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? defaultIfEnabled : null)}
        />
        <span className="font-medium text-ink-primary">{label}</span>
        {enabled && (
          <span className="ml-auto font-mono text-xs text-ink-tertiary">{pct}%</span>
        )}
      </label>
      {enabled && (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={(e) => onChange(Number(e.target.value) / 100)}
            className="mt-1 w-full"
          />
          <p className="mt-0.5 text-xs text-ink-tertiary">{hint}</p>
        </>
      )}
    </div>
  );
}
