'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Field, SecondaryButton } from '@/components/form';
import type { AdminDocumentDetail } from '@/lib/api';

// Text-range picker. Captures a verbatim excerpt + ~200 chars of context on
// either side from the document's source text.
//
// Implementation note: we render the source as a <pre> element rather than
// a <textarea>. Textareas choke on large bodies (a 100-page manual is ~200K
// chars; selection becomes laggy or broken in some browsers). A <pre> with a
// single text node lets the native browser selection API give us exact
// character offsets via Range.startOffset / endOffset.
//
// On "Capture selection", we read window.getSelection(), check the range
// is inside our source pane, and slice the original sourceText to produce
// the excerpt + context windows. Page hint comes from `<!-- page:N -->`
// markers (PDF extractions).

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
  const preRef = useRef<HTMLPreElement | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // Live preview of what's currently highlighted, refreshed on selectionchange.
  const [livePreview, setLivePreview] = useState<{ start: number; end: number } | null>(
    null,
  );

  const hasMarkers = useMemo(() => /<!--\s*page:\d+\s*-->/.test(sourceText), [sourceText]);

  // Walk a Range endpoint to a global offset within the <pre>'s text. Each run
  // of text inside <pre> may be its own text node (when React rerenders); we
  // sum text node lengths up to the endpoint to get the character offset
  // relative to sourceText.
  function rangeEndpointToOffset(node: Node, offsetInNode: number): number | null {
    const root = preRef.current;
    if (!root) return null;
    if (!root.contains(node)) return null;
    let acc = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      if (n === node) return acc + offsetInNode;
      acc += (n as Text).data.length;
      n = walker.nextNode();
    }
    return null;
  }

  function readSelection(): { start: number; end: number } | null {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const root = preRef.current;
    if (!root || !root.contains(range.commonAncestorContainer)) return null;
    const start = rangeEndpointToOffset(range.startContainer, range.startOffset);
    const end = rangeEndpointToOffset(range.endContainer, range.endOffset);
    if (start == null || end == null) return null;
    if (end <= start) return null;
    return { start, end };
  }

  // Watch the selection live so the user gets feedback while highlighting.
  useEffect(() => {
    function onSel() {
      const r = readSelection();
      setLivePreview(r);
    }
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build the captured anchor object for a given selection range. Pure —
  // returns null on too-short selections so callers can show a warning.
  function buildCaptureFromRange(
    start: number,
    end: number,
  ): {
    excerpt: string;
    contextBefore: string;
    contextAfter: string;
    pageHint: number | null;
  } | null {
    const excerpt = sourceText.slice(start, end);
    if (excerpt.length < 8) return null;
    const before = sourceText.slice(Math.max(0, start - CONTEXT_CHARS), start);
    const after = sourceText.slice(end, end + CONTEXT_CHARS);
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
    return { excerpt, contextBefore: before, contextAfter: after, pageHint };
  }

  // Auto-capture: when the user releases the mouse anywhere with a valid
  // selection inside the source pane, push the anchor up to the parent.
  // No "Capture selection" click required. The explicit button stays as a
  // manual fallback for keyboard-only selection.
  useEffect(() => {
    function onMouseUp() {
      const r = readSelection();
      if (!r) return;
      const captured = buildCaptureFromRange(r.start, r.end);
      if (captured) {
        setWarning(null);
        onChange(captured);
      }
    }
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceText, hasMarkers]);

  function captureSelection() {
    setWarning(null);
    const r = livePreview ?? readSelection();
    if (!r) {
      setWarning('Highlight some text in the source pane first.');
      return;
    }
    const captured = buildCaptureFromRange(r.start, r.end);
    if (!captured) {
      setWarning('Selection is too short. Pick at least a full phrase.');
      return;
    }
    onChange(captured);
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
    <div className="flex h-full flex-col gap-3">
      <Field
        label="Source text"
        hint={
          hasMarkers
            ? 'Drag to highlight a phrase — it is captured automatically when you release. Page hint is auto-detected from `<!-- page:N -->` markers.'
            : 'Drag to highlight a phrase — it is captured automatically when you release the mouse.'
        }
      >
        <pre
          ref={preRef}
          className="form-input min-h-[480px] flex-1 select-text overflow-auto whitespace-pre-wrap break-words rounded border border-line-subtle bg-surface-raised p-3 font-mono text-xs leading-relaxed"
          tabIndex={0}
          // user-select: text — explicit so any parent CSS reset doesn't kill it
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        >
          {sourceText}
        </pre>
      </Field>
      <div className="flex items-center gap-2">
        <SecondaryButton type="button" onClick={captureSelection}>
          Capture selection
        </SecondaryButton>
        {livePreview && (
          <span className="text-xs text-ink-tertiary">
            {livePreview.end - livePreview.start} chars highlighted
          </span>
        )}
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
