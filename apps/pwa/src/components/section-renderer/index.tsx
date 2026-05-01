'use client';

// SectionRenderer — render one document_section in the PWA's part overlay.
// Branches by `kind` to a kind-specific component.
//
// The PWA only ever sees sections that:
//   - link to the current part
//   - are not flagged for re-validation (filtered server-side)
// So we don't need to render placeholders for missing/unfindable anchors.
// If an anchor is no longer findable in the current document text, the
// section should have been flagged + filtered before reaching here.

import { ShieldAlert } from 'lucide-react';
import type { DocumentBody, PwaDocumentSection } from '@/lib/api';
import { PdfSection } from './pdf-section';
import { TextSection } from './text-section';
import { VideoSection } from './video-section';

export interface SectionRendererProps {
  doc: DocumentBody;
  section: PwaDocumentSection;
}

export function SectionRenderer({ doc, section }: SectionRendererProps): React.ReactElement {
  return (
    <article className="border-b border-line py-5 first:pt-2 last:border-0">
      <header className="mb-2 flex flex-wrap items-center gap-2 px-4">
        <h3 className="text-base font-semibold text-ink-primary">{section.title}</h3>
        {section.safetyCritical && (
          <span className="pill pill-safety">
            <ShieldAlert size={10} strokeWidth={2.5} />
            Safety
          </span>
        )}
        <span className="ml-auto text-xs text-ink-tertiary">
          {anchorSummary(section)}
        </span>
      </header>
      {section.description && (
        <p className="mb-3 px-4 text-sm text-ink-secondary">{section.description}</p>
      )}
      <div className="px-0">
        <SectionBody doc={doc} section={section} />
      </div>
    </article>
  );
}

function SectionBody({ doc, section }: SectionRendererProps): React.ReactElement {
  if (section.kind === 'page_range') {
    return <PdfSection doc={doc} section={section} />;
  }
  if (section.kind === 'time_range') {
    return <VideoSection doc={doc} section={section} />;
  }
  // text_range: always show the verbatim excerpt as a styled callout up top
  // (so the tech sees the exact text the admin selected, regardless of
  // whether the PDF text-layer highlight lands). For PDF source docs we ALSO
  // render the original page below for visual context. For markdown sources
  // the TextSection already handles its own surrounding-context render.
  if (doc.kind === 'pdf') {
    return (
      <div className="flex flex-col gap-3">
        <ExcerptCallout section={section} />
        <PdfSection doc={doc} section={section} />
      </div>
    );
  }
  return <TextSection doc={doc} section={section} />;
}

function ExcerptCallout({ section }: { section: PwaDocumentSection }): React.ReactElement | null {
  const excerpt = section.anchorExcerpt;
  if (!excerpt) return null;
  const before = section.anchorContextBefore?.trim();
  const after = section.anchorContextAfter?.trim();
  return (
    <div className="mx-4 rounded-md border-l-4 border-brand bg-brand/5 px-4 py-3">
      <p className="caption mb-1 text-ink-tertiary">From the manual</p>
      <p className="text-base leading-relaxed text-ink-primary">
        {before && (
          <span className="text-ink-tertiary">…{tail(before, 80)} </span>
        )}
        <span className="rounded bg-yellow-200/40 px-0.5 font-medium text-ink-primary">
          {excerpt}
        </span>
        {after && (
          <span className="text-ink-tertiary"> {head(after, 80)}…</span>
        )}
      </p>
    </div>
  );
}

function tail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(s.length - n) : s;
}
function head(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function anchorSummary(s: PwaDocumentSection): string {
  if (s.kind === 'page_range') {
    if (s.pageStart === s.pageEnd) return `Page ${s.pageStart}`;
    return `Pages ${s.pageStart}–${s.pageEnd}`;
  }
  if (s.kind === 'text_range') {
    if (s.textPageHint != null) return `Page ${s.textPageHint}`;
    return 'Text excerpt';
  }
  return `${fmtT(s.timeStartSeconds)}–${fmtT(s.timeEndSeconds)}`;
}

function fmtT(secs: number | null): string {
  if (secs == null) return '?';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
