// Admin API for document_sections — page/text/time anchors that admins
// author against a document and link to one or more parts.
//
// Surface:
//   GET    /admin/documents/:documentId/sections
//   POST   /admin/documents/:documentId/sections
//   PATCH  /admin/document-sections/:sectionId
//   DELETE /admin/document-sections/:sectionId
//   GET    /admin/document-sections/:sectionId/parts
//   PUT    /admin/document-sections/:sectionId/parts        — set-replace
//   GET    /admin/parts/:partId/sections                    — inverse
//   POST   /admin/documents/:documentId/sections/revalidate — re-run on demand
//
// All writes are scoped to the document's owner org and rejected when the
// parent content_pack_version is published. The PWA never reads from this
// surface — it sees sections via /parts/:partId/resources.

import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, asc } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { z } from 'zod';
import { UuidSchema } from '@platform/shared';
import {
  revalidateSection,
  embed,
  type RevalidatableSection,
  type EmbedSimilarityFn,
} from '@platform/ai';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';

// ---------------------------------------------------------------------------
// Zod schemas — request bodies
// ---------------------------------------------------------------------------

const PageRangeBody = z.object({
  kind: z.literal('page_range'),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  safetyCritical: z.boolean().optional(),
  orderingHint: z.number().int().optional(),
  pageStart: z.number().int().min(1),
  pageEnd: z.number().int().min(1),
});

const TextRangeBody = z.object({
  kind: z.literal('text_range'),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  safetyCritical: z.boolean().optional(),
  orderingHint: z.number().int().optional(),
  anchorExcerpt: z.string().min(1).max(8000),
  anchorContextBefore: z.string().max(2000).nullable().optional(),
  anchorContextAfter: z.string().max(2000).nullable().optional(),
  textPageHint: z.number().int().min(1).nullable().optional(),
});

const TimeRangeBody = z.object({
  kind: z.literal('time_range'),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  safetyCritical: z.boolean().optional(),
  orderingHint: z.number().int().optional(),
  timeStartSeconds: z.number().min(0),
  timeEndSeconds: z.number().min(0),
});

const SectionCreateBody = z.discriminatedUnion('kind', [
  PageRangeBody,
  TextRangeBody,
  TimeRangeBody,
]);

const SectionPatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    safetyCritical: z.boolean().optional(),
    orderingHint: z.number().int().optional(),
    // Anchor refinements — caller may switch picks within the same kind.
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).optional(),
    anchorExcerpt: z.string().min(1).max(8000).optional(),
    anchorContextBefore: z.string().max(2000).nullable().optional(),
    anchorContextAfter: z.string().max(2000).nullable().optional(),
    textPageHint: z.number().int().min(1).nullable().optional(),
    timeStartSeconds: z.number().min(0).optional(),
    timeEndSeconds: z.number().min(0).optional(),
    // Admin can manually clear or set the flag (e.g., after reviewing a flagged
    // section and deciding the anchors are still good).
    needsRevalidation: z.boolean().optional(),
    revalidationReason: z.string().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type SectionRow = typeof schema.documentSections.$inferSelect;

function rowToDTO(row: SectionRow): {
  id: string;
  documentId: string;
  kind: typeof row.kind;
  title: string;
  description: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  pageStart: number | null;
  pageEnd: number | null;
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;
  needsRevalidation: boolean;
  revalidationReason: string | null;
  sourceExtractionAt: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: row.id,
    documentId: row.documentId,
    kind: row.kind,
    title: row.title,
    description: row.description,
    safetyCritical: row.safetyCritical,
    orderingHint: row.orderingHint,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    textPageHint: row.textPageHint,
    anchorExcerpt: row.anchorExcerpt,
    anchorContextBefore: row.anchorContextBefore,
    anchorContextAfter: row.anchorContextAfter,
    timeStartSeconds: row.timeStartSeconds,
    timeEndSeconds: row.timeEndSeconds,
    needsRevalidation: row.needsRevalidation,
    revalidationReason: row.revalidationReason,
    sourceExtractionAt: row.sourceExtractionAt
      ? row.sourceExtractionAt.toISOString()
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers — load + scope
// ---------------------------------------------------------------------------

async function loadDocumentForWrite(
  db: Database,
  documentId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
  isDraft: boolean;
} | null> {
  const doc = await db.query.documents.findFirst({
    where: eq(schema.documents.id, documentId),
    with: { packVersion: { with: { pack: true } } },
  });
  if (!doc) return null;
  requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
  return {
    doc,
    ownerOrganizationId: doc.packVersion.pack.ownerOrganizationId,
    isDraft: doc.packVersion.status === 'draft',
  };
}

async function loadSectionForWrite(
  db: Database,
  sectionId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  section: SectionRow;
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
  isDraft: boolean;
} | null> {
  const section = await db.query.documentSections.findFirst({
    where: eq(schema.documentSections.id, sectionId),
  });
  if (!section) return null;
  const ctx = await loadDocumentForWrite(db, section.documentId, scope);
  if (!ctx) return null;
  return { section, ...ctx };
}

// Cosine similarity for the embedding-fallback in re-validation.
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

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminSections(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId — document detail for the sections page
  // (the existing /admin/content-packs/:id returns nested docs; this is a
  // lighter, scoped lookup specifically for the document detail editor).
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();
      const d = ctx.doc as typeof schema.documents.$inferSelect & {
        packVersion: typeof schema.contentPackVersions.$inferSelect & {
          pack: typeof schema.contentPacks.$inferSelect;
        };
      };
      return {
        id: d.id,
        title: d.title,
        kind: d.kind,
        contentType: d.contentType,
        originalFilename: d.originalFilename,
        sizeBytes: d.sizeBytes,
        bodyMarkdown: d.bodyMarkdown,
        extractedText: d.extractedText,
        extractionStatus: d.extractionStatus,
        extractionError: d.extractionError,
        extractedAt: d.extractedAt ? d.extractedAt.toISOString() : null,
        safetyCritical: d.safetyCritical,
        language: d.language,
        orderingHint: d.orderingHint,
        storageKey: d.storageKey,
        thumbnailStorageKey: d.thumbnailStorageKey,
        fileUrl: d.storageKey ? storage.publicUrl(d.storageKey) : null,
        thumbnailUrl: d.thumbnailStorageKey
          ? storage.publicUrl(d.thumbnailStorageKey)
          : null,
        contentPackVersionId: d.contentPackVersionId,
        contentPackId: d.packVersion.pack.id,
        contentPackName: d.packVersion.pack.name,
        contentPackVersionNumber: d.packVersion.versionNumber,
        contentPackVersionStatus: d.packVersion.status,
        ownerOrganizationId: ctx.ownerOrganizationId,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId/sections — list sections on a doc
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/sections',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const rows = await db.query.documentSections.findMany({
        where: eq(schema.documentSections.documentId, request.params.documentId),
        orderBy: [
          asc(schema.documentSections.orderingHint),
          asc(schema.documentSections.createdAt),
        ],
      });
      return rows.map(rowToDTO);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/sections — create
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: z.infer<typeof SectionCreateBody>;
  }>(
    '/admin/documents/:documentId/sections',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: SectionCreateBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();
      if (!ctx.isDraft) {
        return reply.badRequest(
          'Cannot create sections on a published version. Create a new draft version.',
        );
      }
      const body = request.body;

      // Per-kind validation that goes beyond Zod's discriminated union.
      if (body.kind === 'page_range') {
        if (body.pageStart > body.pageEnd) {
          return reply.badRequest('pageStart must be <= pageEnd.');
        }
      }
      if (body.kind === 'time_range') {
        if (body.timeStartSeconds >= body.timeEndSeconds) {
          return reply.badRequest('timeStartSeconds must be < timeEndSeconds.');
        }
      }

      const insertValues: typeof schema.documentSections.$inferInsert = {
        documentId: request.params.documentId,
        kind: body.kind,
        title: body.title,
        description: body.description ?? null,
        safetyCritical: body.safetyCritical ?? false,
        orderingHint: body.orderingHint ?? 0,
        createdByUserId: auth.userId,
        // Snapshot the doc's current extractedAt so re-validation can short-
        // circuit until the doc is re-extracted.
        sourceExtractionAt: ctx.doc.extractedAt ?? null,
      };
      if (body.kind === 'page_range') {
        insertValues.pageStart = body.pageStart;
        insertValues.pageEnd = body.pageEnd;
      } else if (body.kind === 'text_range') {
        insertValues.anchorExcerpt = body.anchorExcerpt;
        insertValues.anchorContextBefore = body.anchorContextBefore ?? null;
        insertValues.anchorContextAfter = body.anchorContextAfter ?? null;
        insertValues.textPageHint = body.textPageHint ?? null;
      } else {
        insertValues.timeStartSeconds = body.timeStartSeconds;
        insertValues.timeEndSeconds = body.timeEndSeconds;
      }

      const [row] = await db
        .insert(schema.documentSections)
        .values(insertValues)
        .returning();
      if (!row) return reply.internalServerError('Failed to create section.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'document_section.created',
        targetType: 'document_section',
        targetId: row.id,
        payload: {
          documentId: row.documentId,
          kind: row.kind,
          title: row.title,
          safetyCritical: row.safetyCritical,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return rowToDTO(row);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/document-sections/:sectionId
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { sectionId: string };
    Body: z.infer<typeof SectionPatchBody>;
  }>(
    '/admin/document-sections/:sectionId',
    {
      schema: {
        params: z.object({ sectionId: UuidSchema }),
        body: SectionPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSectionForWrite(db, request.params.sectionId, scope);
      if (!ctx) return reply.notFound();
      if (!ctx.isDraft) {
        return reply.badRequest('Cannot edit sections on a published version.');
      }
      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };

      // Common fields
      if (b.title !== undefined) patch.title = b.title;
      if (b.description !== undefined) patch.description = b.description;
      if (b.safetyCritical !== undefined) patch.safetyCritical = b.safetyCritical;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.needsRevalidation !== undefined) patch.needsRevalidation = b.needsRevalidation;
      if (b.revalidationReason !== undefined)
        patch.revalidationReason = b.revalidationReason;

      // Kind-specific fields — guard against cross-kind contamination.
      if (ctx.section.kind === 'page_range') {
        if (b.pageStart !== undefined) patch.pageStart = b.pageStart;
        if (b.pageEnd !== undefined) patch.pageEnd = b.pageEnd;
        const ps = (patch.pageStart as number | undefined) ?? ctx.section.pageStart;
        const pe = (patch.pageEnd as number | undefined) ?? ctx.section.pageEnd;
        if (ps != null && pe != null && ps > pe) {
          return reply.badRequest('pageStart must be <= pageEnd.');
        }
      } else if (ctx.section.kind === 'text_range') {
        if (b.anchorExcerpt !== undefined) patch.anchorExcerpt = b.anchorExcerpt;
        if (b.anchorContextBefore !== undefined)
          patch.anchorContextBefore = b.anchorContextBefore;
        if (b.anchorContextAfter !== undefined)
          patch.anchorContextAfter = b.anchorContextAfter;
        if (b.textPageHint !== undefined) patch.textPageHint = b.textPageHint;
      } else {
        if (b.timeStartSeconds !== undefined) patch.timeStartSeconds = b.timeStartSeconds;
        if (b.timeEndSeconds !== undefined) patch.timeEndSeconds = b.timeEndSeconds;
        const ts =
          (patch.timeStartSeconds as number | undefined) ?? ctx.section.timeStartSeconds;
        const te = (patch.timeEndSeconds as number | undefined) ?? ctx.section.timeEndSeconds;
        if (ts != null && te != null && ts >= te) {
          return reply.badRequest('timeStartSeconds must be < timeEndSeconds.');
        }
      }

      // If the admin re-anchored or moved pages, snapshot the doc's current
      // extractedAt so the next re-extract treats this as freshly validated.
      const reAnchored =
        b.pageStart !== undefined ||
        b.pageEnd !== undefined ||
        b.anchorExcerpt !== undefined ||
        b.anchorContextBefore !== undefined ||
        b.anchorContextAfter !== undefined ||
        b.textPageHint !== undefined ||
        b.timeStartSeconds !== undefined ||
        b.timeEndSeconds !== undefined;
      if (reAnchored) {
        patch.sourceExtractionAt = ctx.doc.extractedAt ?? null;
        if (b.needsRevalidation === undefined) {
          patch.needsRevalidation = false;
          patch.revalidationReason = null;
        }
      }

      const [updated] = await db
        .update(schema.documentSections)
        .set(patch)
        .where(eq(schema.documentSections.id, ctx.section.id))
        .returning();
      if (!updated) return reply.internalServerError('Update failed');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'document_section.updated',
        targetType: 'document_section',
        targetId: updated.id,
        payload: { fields: Object.keys(b), reAnchored },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return rowToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/document-sections/:sectionId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { sectionId: string } }>(
    '/admin/document-sections/:sectionId',
    { schema: { params: z.object({ sectionId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSectionForWrite(db, request.params.sectionId, scope);
      if (!ctx) return reply.notFound();
      if (!ctx.isDraft) {
        return reply.badRequest('Cannot delete sections on a published version.');
      }
      await db
        .delete(schema.documentSections)
        .where(eq(schema.documentSections.id, ctx.section.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'document_section.deleted',
        targetType: 'document_section',
        targetId: ctx.section.id,
        payload: {
          documentId: ctx.section.documentId,
          kind: ctx.section.kind,
          title: ctx.section.title,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/document-sections/:sectionId/parts — list linked parts
  // -------------------------------------------------------------------------
  app.get<{ Params: { sectionId: string } }>(
    '/admin/document-sections/:sectionId/parts',
    { schema: { params: z.object({ sectionId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSectionForWrite(db, request.params.sectionId, scope);
      if (!ctx) return reply.notFound();

      const links = await db.query.partDocumentSections.findMany({
        where: eq(schema.partDocumentSections.documentSectionId, ctx.section.id),
      });
      if (links.length === 0) return [];
      const partIds = [...new Set(links.map((l) => l.partId))];
      const parts = await db.query.parts.findMany({
        where: inArray(schema.parts.id, partIds),
      });
      const byId = new Map(parts.map((p) => [p.id, p]));
      return links
        .map((l) => {
          const p = byId.get(l.partId);
          if (!p) return null;
          return {
            linkId: l.id,
            partId: p.id,
            oemPartNumber: p.oemPartNumber,
            displayName: p.displayName,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /admin/document-sections/:sectionId/parts — set-replace
  // -------------------------------------------------------------------------
  app.put<{
    Params: { sectionId: string };
    Body: { partIds: string[] };
  }>(
    '/admin/document-sections/:sectionId/parts',
    {
      schema: {
        params: z.object({ sectionId: UuidSchema }),
        body: z.object({ partIds: z.array(UuidSchema) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadSectionForWrite(db, request.params.sectionId, scope);
      if (!ctx) return reply.notFound();
      if (!ctx.isDraft) {
        return reply.badRequest('Cannot modify section links on a published version.');
      }
      const wanted = new Set(request.body.partIds);

      if (wanted.size > 0) {
        const parts = await db.query.parts.findMany({
          where: inArray(schema.parts.id, [...wanted]),
        });
        if (parts.length !== wanted.size) {
          return reply.notFound('One or more parts not found.');
        }
        for (const p of parts) requireOrgInScope(scope, p.ownerOrganizationId);
      }

      let added = 0;
      let removed = 0;
      await db.transaction(async (tx) => {
        const existing = await tx.query.partDocumentSections.findMany({
          where: eq(schema.partDocumentSections.documentSectionId, ctx.section.id),
        });
        const existingIds = new Set(existing.map((e) => e.partId));
        const toDelete = existing.filter((e) => !wanted.has(e.partId));
        const toInsert = [...wanted].filter((pid) => !existingIds.has(pid));
        removed = toDelete.length;
        added = toInsert.length;

        if (toDelete.length > 0) {
          await tx.delete(schema.partDocumentSections).where(
            inArray(
              schema.partDocumentSections.id,
              toDelete.map((d) => d.id),
            ),
          );
        }
        if (toInsert.length > 0) {
          await tx.insert(schema.partDocumentSections).values(
            toInsert.map((partId) => ({
              partId,
              documentSectionId: ctx.section.id,
              createdByUserId: auth.userId,
            })),
          );
        }
      });

      if (added > 0 || removed > 0) {
        await db.insert(schema.auditEvents).values({
          organizationId: ctx.ownerOrganizationId,
          actorUserId: auth.userId,
          eventType: 'document_section.parts.set',
          targetType: 'document_section',
          targetId: ctx.section.id,
          payload: {
            documentId: ctx.section.documentId,
            partCount: wanted.size,
            added,
            removed,
          },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      }

      return { ok: true, count: wanted.size, added, removed };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/parts/:partId/sections — inverse listing for the part page
  // -------------------------------------------------------------------------
  app.get<{ Params: { partId: string } }>(
    '/admin/parts/:partId/sections',
    { schema: { params: z.object({ partId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const part = await db.query.parts.findFirst({
        where: eq(schema.parts.id, request.params.partId),
      });
      if (!part) return reply.notFound();
      requireOrgInScope(scope, part.ownerOrganizationId);

      const links = await db.query.partDocumentSections.findMany({
        where: eq(schema.partDocumentSections.partId, part.id),
      });
      if (links.length === 0) return [];
      const sectionIds = [...new Set(links.map((l) => l.documentSectionId))];
      const sections = await db.query.documentSections.findMany({
        where: inArray(schema.documentSections.id, sectionIds),
        with: { document: true },
      });

      return sections.map((s) => ({
        ...rowToDTO(s),
        documentTitle: s.document.title,
        documentKind: s.document.kind,
      }));
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/sections/revalidate — manual trigger
  // -------------------------------------------------------------------------
  app.post<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/sections/revalidate',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const sections = await db.query.documentSections.findMany({
        where: eq(schema.documentSections.documentId, ctx.doc.id),
      });
      if (sections.length === 0) return { accepted: 0, flagged: 0, total: 0 };

      // Pull the doc's chunks once for the embedding fallback. Chunks carry
      // their own embeddings; we just need to embed the section excerpt and
      // cosine against each.
      const chunks = await db.query.documentChunks.findMany({
        where: eq(schema.documentChunks.documentId, ctx.doc.id),
      });

      const newExtractedText = ctx.doc.extractedText ?? ctx.doc.bodyMarkdown ?? null;
      const newDuration = (() => {
        const m = (ctx.doc as { metadata?: unknown }).metadata as
          | { durationSeconds?: number }
          | null
          | undefined;
        return typeof m?.durationSeconds === 'number' ? m.durationSeconds : null;
      })();

      let accepted = 0;
      let flagged = 0;
      for (const s of sections) {
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

        const embedSimilarity: EmbedSimilarityFn | undefined =
          chunks.length > 0
            ? async ({ excerpt }) => {
                const queryVec = await embed(excerpt, 'query');
                let bestIndex = 0;
                let bestScore = -Infinity;
                for (let i = 0; i < chunks.length; i++) {
                  const ch = chunks[i]!;
                  const score = cosine(queryVec, ch.embedding ?? []);
                  if (score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                  }
                }
                return { bestIndex, bestScore: Math.max(0, bestScore) };
              }
            : undefined;

        const outcome = await revalidateSection({
          section: subject,
          oldExtractedText: null,
          newExtractedText,
          newDurationSeconds: newDuration,
          embedSimilarity,
          candidateChunks: chunks.map((c) => ({
            chunkId: c.id,
            text: c.content,
          })),
        });

        if (outcome.status === 'accepted') {
          accepted += 1;
          const updates: Record<string, unknown> = {
            needsRevalidation: false,
            revalidationReason: null,
            sourceExtractionAt: ctx.doc.extractedAt ?? new Date(),
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

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'document_section.revalidated',
        targetType: 'document',
        targetId: ctx.doc.id,
        payload: {
          accepted,
          flagged,
          total: sections.length,
          trigger: 'manual',
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { accepted, flagged, total: sections.length };
    },
  );
}
