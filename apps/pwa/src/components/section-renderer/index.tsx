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

import { useState } from 'react';
import { ChevronDown, ChevronUp, FileText, ShieldAlert } from 'lucide-react';
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
  // text_range — always render the surrounding markdown as readable text
  // with the excerpt highlighted, regardless of source kind. For PDF docs
  // (extracted via AI), the markdown is doc.extractedText; for hand-
  // authored docs, it's doc.bodyMarkdown. Either way the tech reads text.
  // Original PDF page is available behind a collapsible toggle for techs
  // who want to see the OEM-formatted original.
  return <TextRangeBody doc={doc} section={section} />;
}

function TextRangeBody({
  doc,
  section,
}: SectionRendererProps): React.ReactElement {
  const [showPdf, setShowPdf] = useState(false);
  const isPdf = doc.kind === 'pdf';
  return (
    <div className="flex flex-col gap-3">
      <TextSection doc={doc} section={section} />
      {isPdf && (
        <div className="mx-4 mt-1">
          <button
            type="button"
            onClick={() => setShowPdf((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-xs text-ink-secondary hover:border-brand/40 hover:bg-surface-elevated"
          >
            <FileText size={12} strokeWidth={2} />
            {showPdf ? 'Hide original page' : 'View on original PDF page'}
            {showPdf ? (
              <ChevronUp size={12} strokeWidth={2} />
            ) : (
              <ChevronDown size={12} strokeWidth={2} />
            )}
          </button>
          {showPdf && (
            <div className="mt-3">
              <PdfSection doc={doc} section={section} />
            </div>
          )}
        </div>
      )}
    </div>
  );
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
