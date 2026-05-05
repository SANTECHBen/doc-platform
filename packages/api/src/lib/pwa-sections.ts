// Shared helpers for projecting `documentSections` rows into the shape
// the PWA renders. Keeps the projection + sort + revalidation filter in
// one place so /parts/:partId/resources and /content-pack-versions/:id/
// documents?withSections=1 stay consistent.

import { inArray } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';

export interface PwaSection {
  id: string;
  kind: typeof schema.documentSections.$inferSelect.kind;
  title: string;
  description: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  pageStart: number | null;
  pageEnd: number | null;
  startY: number | null;
  endY: number | null;
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;
}

// Strip internal fields (revalidation flags, audit metadata, ownership
// snapshots) so the PWA only gets what it needs to render. Tech users
// never see flagged sections — they're filtered out by the caller.
export function toPwaSection(
  s: typeof schema.documentSections.$inferSelect,
): PwaSection {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    description: s.description,
    safetyCritical: s.safetyCritical,
    orderingHint: s.orderingHint,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    startY: s.startY,
    endY: s.endY,
    textPageHint: s.textPageHint,
    anchorExcerpt: s.anchorExcerpt,
    anchorContextBefore: s.anchorContextBefore,
    anchorContextAfter: s.anchorContextAfter,
    timeStartSeconds: s.timeStartSeconds,
    timeEndSeconds: s.timeEndSeconds,
  };
}

// Sort sections within one document for the PWA: safety-critical first,
// then authoring order, then natural anchor position (pageStart /
// timeStart) so the rendering order is intuitive when ordering_hint is
// left at 0.
export function comparePwaSections(a: PwaSection, b: PwaSection): number {
  if (a.safetyCritical !== b.safetyCritical) return a.safetyCritical ? -1 : 1;
  if (a.orderingHint !== b.orderingHint) return a.orderingHint - b.orderingHint;
  const aPos = a.pageStart ?? a.timeStartSeconds ?? 0;
  const bPos = b.pageStart ?? b.timeStartSeconds ?? 0;
  if (aPos !== bPos) return aPos - bPos;
  return a.title.localeCompare(b.title);
}

// Fetch sections for a set of documentIds, drop ones still flagged for
// re-validation, project to PwaSection, and group by documentId. Used by
// both the part-resources route and the content-pack docs list route.
//
// Returns a Map<docId, PwaSection[]>. Missing docIds (= no sections at
// all on the doc) simply won't appear in the map; callers should treat
// "missing" as "legacy doc with no authored sections".
export async function fetchPwaSectionsByDoc(
  db: Database,
  docIds: string[],
): Promise<Map<string, PwaSection[]>> {
  if (docIds.length === 0) return new Map();

  const rows = await db.query.documentSections.findMany({
    where: inArray(schema.documentSections.documentId, docIds),
  });

  const byDoc = new Map<string, PwaSection[]>();
  for (const s of rows) {
    if (s.needsRevalidation) continue;
    const arr = byDoc.get(s.documentId) ?? [];
    arr.push(toPwaSection(s));
    byDoc.set(s.documentId, arr);
  }
  for (const [k, arr] of byDoc) {
    arr.sort(comparePwaSections);
    byDoc.set(k, arr);
  }
  return byDoc;
}
