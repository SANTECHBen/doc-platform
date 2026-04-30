// Document section re-validation hook.
//
// Fires from the extraction pipeline after `processDocument` advances
// `documents.extractedAt`. For every section on the document whose
// `source_extraction_at` is older than the new extractedAt, we run the
// three-stage re-validation algorithm and either accept (clearing flags
// + bumping the snapshot) or flag for manual review.
//
// Idempotent: re-running on a document whose sections are already up-to-
// date is a no-op (the timestamp short-circuit catches that).

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import {
  revalidateSection,
  embed,
  type RevalidatableSection,
  type EmbedSimilarityFn,
} from '@platform/ai';

export interface SectionRevalidationResult {
  total: number;
  accepted: number;
  flagged: number;
  skipped: number;
}

export interface RevalidateAfterExtractParams {
  db: Database;
  documentId: string;
  /** Snapshot of `documents.extractedText` before re-extraction overwrote it.
   *  Pass null when this is the doc's first successful extraction (no prior
   *  text to compare against — page_range falls back to count check; text_
   *  range still runs against the new text). */
  oldExtractedText: string | null;
}

/**
 * Run re-validation for one document. Caller is the extraction pipeline
 * trigger (see admin.ts triggerExtraction). Errors are caught + logged into
 * `revalidation_reason` rather than thrown — a transient embed failure
 * shouldn't break extraction.
 */
export async function revalidateDocumentSections(
  params: RevalidateAfterExtractParams,
): Promise<SectionRevalidationResult> {
  const { db, documentId, oldExtractedText } = params;

  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, documentId),
  });
  if (!doc) {
    return { total: 0, accepted: 0, flagged: 0, skipped: 0 };
  }

  const sections = await db.query.documentSections.findMany({
    where: eq(schema.documentSections.documentId, documentId),
  });
  if (sections.length === 0) {
    return { total: 0, accepted: 0, flagged: 0, skipped: 0 };
  }

  const newExtractedText = doc.extractedText ?? doc.bodyMarkdown ?? null;
  const newDuration = (() => {
    const m = (doc as { metadata?: unknown }).metadata as
      | { durationSeconds?: number }
      | null
      | undefined;
    return typeof m?.durationSeconds === 'number' ? m.durationSeconds : null;
  })();
  const newExtractedAt = doc.extractedAt;

  // Lazy-load chunks only when at least one section is text_range AND will
  // need an embedding fallback.
  let chunks: Array<typeof schema.documentChunks.$inferSelect> | null = null;
  async function getChunks(): Promise<Array<typeof schema.documentChunks.$inferSelect>> {
    if (chunks !== null) return chunks;
    chunks = await db.query.documentChunks.findMany({
      where: eq(schema.documentChunks.documentId, documentId),
    });
    return chunks;
  }

  let accepted = 0;
  let flagged = 0;
  let skipped = 0;

  for (const s of sections) {
    // Idempotency: if this section was already validated against the current
    // extraction, skip it.
    if (
      newExtractedAt &&
      s.sourceExtractionAt &&
      s.sourceExtractionAt >= newExtractedAt
    ) {
      skipped += 1;
      continue;
    }

    const subject: RevalidatableSection = {
      id: s.id,
      kind: s.kind,
      pageStart: s.pageStart,
      pageEnd: s.pageEnd,
      textPageHint: s.textPageHint,
      anchorExcerpt: s.anchorExcerpt,
      anchorContextBefore: s.anchorContextBefore,
      anchorContextAfter: s.anchorContextAfter,
      timeStartSeconds: s.timeStartSeconds,
      timeEndSeconds: s.timeEndSeconds,
    };

    let embedSimilarity: EmbedSimilarityFn | undefined = undefined;
    let candidateChunks: Array<{ chunkId: string | null; text: string }> | undefined;
    if (s.kind === 'text_range') {
      const ch = await getChunks();
      if (ch.length > 0) {
        candidateChunks = ch.map((c) => ({ chunkId: c.id, text: c.content }));
        embedSimilarity = async ({ excerpt }) => {
          try {
            const queryVec = await embed(excerpt, 'query');
            let bestIndex = 0;
            let bestScore = -Infinity;
            for (let i = 0; i < ch.length; i++) {
              const score = cosine(queryVec, ch[i]!.embedding ?? []);
              if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
              }
            }
            return { bestIndex, bestScore: Math.max(0, bestScore) };
          } catch {
            // Embed failure → return a low score so the algorithm flags rather
            // than misclassifying. The reason will surface in the flag banner.
            return { bestIndex: 0, bestScore: 0 };
          }
        };
      }
    }

    const outcome = await revalidateSection({
      section: subject,
      oldExtractedText,
      newExtractedText,
      newDurationSeconds: newDuration,
      embedSimilarity,
      candidateChunks,
    });

    if (outcome.status === 'accepted') {
      accepted += 1;
      const updates: Record<string, unknown> = {
        needsRevalidation: false,
        revalidationReason: null,
        sourceExtractionAt: newExtractedAt ?? new Date(),
        updatedAt: new Date(),
      };
      if (outcome.updates) {
        if (outcome.updates.anchorExcerpt !== undefined)
          updates.anchorExcerpt = outcome.updates.anchorExcerpt;
        if (outcome.updates.anchorContextBefore !== undefined)
          updates.anchorContextBefore = outcome.updates.anchorContextBefore;
        if (outcome.updates.anchorContextAfter !== undefined)
          updates.anchorContextAfter = outcome.updates.anchorContextAfter;
        if (outcome.updates.textPageHint !== undefined)
          updates.textPageHint = outcome.updates.textPageHint;
      }
      await db
        .update(schema.documentSections)
        .set(updates)
        .where(eq(schema.documentSections.id, s.id));
    } else {
      flagged += 1;
      await db
        .update(schema.documentSections)
        .set({
          needsRevalidation: true,
          revalidationReason: outcome.reason,
          updatedAt: new Date(),
        })
        .where(eq(schema.documentSections.id, s.id));
    }
  }

  return { total: sections.length, accepted, flagged, skipped };
}

function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
