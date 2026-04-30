'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, SecondaryButton } from '@/components/form';
import type { AdminDocumentDetail } from '@/lib/api';

// Text-range picker. Captures a verbatim excerpt + ~200 chars of context on
// either side from the document's source text. Two modes:
//
//   1. Markdown / structured_procedure: raw bodyMarkdown / extractedText is
//      rendered in a textarea; admin selects with the cursor; "Capture
//      selection" pulls the highlighted span + surrounding context.
//   2. PDF text-layer: TODO — requires the @platform/viewer pdfjs picker
//      with text selection capture (separate component, follow-up).
//
// The captured anchors are excerpt (verbatim), contextBefore/After (~200
// chars), and an optional textPageHint (PDF only — derived from the
// `<!-- page:N -->` markers in extractedText if present).

const CONTEXT_CHARS = 200;

export function TextRangePicker({
  doc,
  anchorExcerpt,
  anchorContextBefore,
  anchorContextAfter,
  textPageHint,
  onChange,
}: {
  doc: AdminDocumentDetail;
  anchorExcerpt: string;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  textPageHint: number | null;
  onChange: (v: {
    excerpt: string;
    contextBefore: string;
    contextAfter: string;
    pageHint: number | null;
  }) => void;
}) {
  const sourceText = doc.bodyMarkdown ?? doc.extractedText ?? '';
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const hasMarkers = useMemo(() => /<!--\s*page:\d+\s*-->/.test(sourceText), [sourceText]);

  function captureSelection() {
    setWarning(null);
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end) {
      setWarning('Highlight some text in the source first.');
      return;
    }
    const excerpt = sourceText.slice(start, end);
    if (excerpt.length < 8) {
      setWarning('Selection is too short. Pick at least a full phrase.');
      return;
    }
    const before = sourceText.slice(Math.max(0, start - CONTEXT_CHARS), start);
    const after = sourceText.slice(end, end + CONTEXT_CHARS);

    // If the source has `<!-- page:N -->` markers, infer the page hint by
    // scanning back from the selection start to the nearest preceding marker.
    let pageHint: number | null = null;
    if (hasMarkers) {
      const re = /<!--\s*page:(\d+)\s*-->/g;
      let lastMatchedPage: number | null = null;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sourceText)) !== null) {
        if (m.index > start) break;
        lastMatchedPage = Number(m[1]);
      }
      pageHint = lastMatchedPage;
    }

    onChange({ excerpt, contextBefore: before, contextAfter: after, pageHint });
  }

  if (!sourceText) {
    return (
      <div className="rounded-md border border-dashed border-line bg-surface p-4 text-sm text-ink-tertiary">
        This document has no extracted text yet. Wait for extraction to finish, or
        re-trigger it from the content pack page.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field
        label="Source text"
        hint={
          hasMarkers
            ? 'Click into the source, highlight a phrase, then "Capture selection". Page hint is auto-detected from markers.'
            : 'Click into the source, highlight a phrase, then "Capture selection".'
        }
      >
        <textarea
          ref={taRef}
          rows={10}
          defaultValue={sourceText}
          // Read-only-ish: we don't want admins editing the source from here.
          // But native selection requires the textarea to be focusable, so
          // we lock changes via onBeforeInput.
          onBeforeInput={(e) => e.preventDefault()}
          onPaste={(e) => e.preventDefault()}
          className="form-textarea font-mono text-xs"
        />
      </Field>
      <div className="flex items-center gap-2">
        <SecondaryButton type="button" onClick={captureSelection}>
          Capture selection
        </SecondaryButton>
        {warning && <span className="text-xs text-signal-warn">{warning}</span>}
      </div>

      <div className="rounded border border-line-subtle bg-surface p-3">
        <p className="caption mb-1">Captured excerpt</p>
        {anchorExcerpt ? (
          <p className="font-mono text-xs text-ink-primary">"{anchorExcerpt}"</p>
        ) : (
          <p className="text-xs italic text-ink-tertiary">No excerpt captured yet.</p>
        )}
        {textPageHint != null && (
          <p className="mt-1 text-xs text-ink-tertiary">Page hint: {textPageHint}</p>
        )}
        {(anchorContextBefore || anchorContextAfter) && (
          <details className="mt-2 text-xs text-ink-tertiary">
            <summary className="cursor-pointer hover:text-ink-secondary">
              Context windows ({(anchorContextBefore ?? '').length} +{' '}
              {(anchorContextAfter ?? '').length} chars)
            </summary>
            <p className="mt-1 whitespace-pre-wrap font-mono">
              <span className="opacity-60">…{anchorContextBefore}</span>
              <span className="bg-yellow-200/30 text-ink-primary"> {anchorExcerpt} </span>
              <span className="opacity-60">{anchorContextAfter}…</span>
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
