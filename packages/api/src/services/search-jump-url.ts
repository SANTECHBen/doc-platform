// Build PWA deep-link payloads per SearchHit. The PWA's voice-search UI
// consumes the result and decides whether to mount VirtualJobAid (for
// procedure_step), SectionViewerOverlay (for document_section), or the
// PDF / document viewer (for doc_chunk).
//
// Returning structured payloads instead of URL strings lets the PWA
// route via in-app navigation (no full reload) and keeps URL-shape
// changes confined to the PWA.

import type { SearchHit } from '@platform/ai';

export type SearchJumpTarget =
  | {
      kind: 'jobaid';
      docId: string;
      initialStepId: string;
      sectionTitle?: string | null;
    }
  | {
      kind: 'section';
      sectionId: string;
      docId: string;
    }
  | {
      kind: 'doc';
      docId: string;
      pageStart?: number | null;
      pageEnd?: number | null;
    };

export function buildSearchJumpTarget(hit: SearchHit): SearchJumpTarget | null {
  if (!hit.documentId) return null;
  switch (hit.sourceType) {
    case 'procedure_step':
      return {
        kind: 'jobaid',
        docId: hit.documentId,
        initialStepId: hit.sourceId,
        sectionTitle:
          typeof hit.metadata.sectionTitle === 'string'
            ? hit.metadata.sectionTitle
            : null,
      };
    case 'document_section':
      return {
        kind: 'section',
        sectionId: hit.sourceId,
        docId: hit.documentId,
      };
    case 'doc_chunk':
      return {
        kind: 'doc',
        docId: hit.documentId,
        // doc_chunk metadata may include chunkIndex but rarely page hints
        // without a dedicated chunker change; expose nulls so the PWA can
        // open the doc viewer without a specific anchor.
        pageStart: null,
        pageEnd: null,
      };
  }
}
