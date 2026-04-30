// Shared types for the document-sections feature, consumed by the API,
// admin, and PWA. The API translates DB rows into these DTOs and the admin /
// PWA render against them.
//
// IMPORTANT: keep these types lean. Re-validation internals (the embedding
// callback, the per-stage match results, etc.) live alongside revalidate.ts —
// callers shouldn't have to know which stage of the ladder accepted a section.

export type DocumentSectionKind = 'page_range' | 'text_range' | 'time_range';

/** What the API sends to clients (admin + PWA). */
export interface DocumentSectionDTO {
  id: string;
  documentId: string;
  kind: DocumentSectionKind;
  title: string;
  description: string | null;
  safetyCritical: boolean;
  orderingHint: number;

  // page_range
  pageStart: number | null;
  pageEnd: number | null;

  // text_range
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;

  // time_range
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;

  // Soft-flag state. Only sent to admin; PWA gets sections with
  // needs_revalidation=true filtered out at the route layer.
  needsRevalidation: boolean;
  revalidationReason: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Input shape for creating a section via the admin API. */
export type DocumentSectionCreateInput =
  | {
      kind: 'page_range';
      title: string;
      description?: string | null;
      safetyCritical?: boolean;
      orderingHint?: number;
      pageStart: number;
      pageEnd: number;
    }
  | {
      kind: 'text_range';
      title: string;
      description?: string | null;
      safetyCritical?: boolean;
      orderingHint?: number;
      anchorExcerpt: string;
      anchorContextBefore?: string | null;
      anchorContextAfter?: string | null;
      textPageHint?: number | null;
    }
  | {
      kind: 'time_range';
      title: string;
      description?: string | null;
      safetyCritical?: boolean;
      orderingHint?: number;
      timeStartSeconds: number;
      timeEndSeconds: number;
    };

/** Recommended ~200-char windows for text_range anchors. The admin UI is
 *  expected to capture exactly this much surrounding context. */
export const ANCHOR_CONTEXT_CHARS = 200;
