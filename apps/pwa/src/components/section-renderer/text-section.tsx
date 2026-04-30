'use client';

// Text section renderer (markdown / structured_procedure).
//
// Renders a slice of bodyMarkdown / extractedText that contains the section's
// excerpt, with a highlight on the matched span. We surface ~600 chars of
// context around the excerpt so the PWA reader has enough surrounding text
// to make sense of the snippet — without dumping the whole document.

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { locateExcerptInPage } from '@platform/viewer';
import type { DocumentBody, PwaDocumentSection } from '@/lib/api';

const CONTEXT_DISPLAY = 600; // chars on each side of the excerpt to render

export function TextSection({
  doc,
  section,
}: {
  doc: DocumentBody;
  section: PwaDocumentSection;
}): React.ReactElement {
  const source = doc.bodyMarkdown ?? '';
  const excerpt = section.anchorExcerpt ?? '';

  const slice = useMemo<{ before: string; match: string; after: string } | null>(() => {
    if (!source || !excerpt) return null;
    const located = locateExcerptInPage({
      pageText: source,
      excerpt,
      contextBefore: section.anchorContextBefore,
      contextAfter: section.anchorContextAfter,
    });
    if (!located) {
      // Anchor unfindable in current source — show the original excerpt as
      // a plain quote so the technician still gets the content.
      return { before: '', match: excerpt, after: '' };
    }
    const start = Math.max(0, located.charStart - CONTEXT_DISPLAY);
    const end = Math.min(source.length, located.charEnd + CONTEXT_DISPLAY);
    return {
      before: source.slice(start, located.charStart),
      match: source.slice(located.charStart, located.charEnd),
      after: source.slice(located.charEnd, end),
    };
  }, [source, excerpt, section.anchorContextBefore, section.anchorContextAfter]);

  if (!slice) {
    return (
      <div className="markdown-body px-4 text-base">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{excerpt}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="markdown-body px-4 text-base">
      {slice.before && (
        <div className="text-sm text-ink-tertiary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{slice.before}</ReactMarkdown>
        </div>
      )}
      <div className="rounded-md border-l-4 border-brand bg-brand/5 px-3 py-2">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{slice.match}</ReactMarkdown>
      </div>
      {slice.after && (
        <div className="mt-2 text-sm text-ink-tertiary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{slice.after}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
