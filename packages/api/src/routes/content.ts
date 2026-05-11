import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import {
  getEffectiveOrgScope,
  requireAuthOrScan,
} from '../middleware/scan-session';
import {
  fetchPwaSectionsByDoc,
  toPwaSection,
  type PwaSection,
} from '../lib/pwa-sections';

export async function registerContentRoutes(app: FastifyInstance) {
  // List documents in a pinned ContentPackVersion. Gated on auth-or-scan:
  // a user can see docs for versions whose owning content_pack belongs to
  // an org in scope. Scan callers see only docs for their QR's org.
  app.get<{
    Params: { versionId: string };
    Querystring: {
      lang?: string;
      withSections?: boolean;
      assetInstanceId?: string;
    };
  }>(
    '/content-pack-versions/:versionId/documents',
    {
      schema: {
        params: z.object({ versionId: UuidSchema }),
        querystring: z.object({
          lang: z.string().length(2).optional(),
          // Opt-in PWA enhancement: when set, each doc carries a
          // `sections` array (or null for legacy docs with none authored).
          withSections: z.coerce.boolean().optional(),
          // When provided, instance-scoped docs (documents.scope_asset_
          // instance_id) are filtered: docs scoped to a different instance
          // are excluded. Required when fetching field-captures versions
          // so a procedure flagged "this unit only" doesn't leak to
          // sibling instances of the same model.
          assetInstanceId: UuidSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      // Resolve the version's owning org; reject cross-tenant access.
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      if (!scope.all && !scope.orgIds.includes(version.pack.ownerOrganizationId)) {
        return reply.notFound();
      }

      const lang = request.query.lang ?? 'en';
      const requestedInstanceId = request.query.assetInstanceId ?? null;
      const rows = await db.query.documents.findMany({
        where: and(
          eq(schema.documents.contentPackVersionId, request.params.versionId),
          eq(schema.documents.language, lang),
          // Instance-scope filter — only takes effect when a doc has
          // scopeAssetInstanceId set. Null-scoped docs (model-wide) are
          // always visible. Scoped docs are visible only when the request
          // names the same instance.
          requestedInstanceId
            ? sql`(${schema.documents.scopeAssetInstanceId} IS NULL OR ${schema.documents.scopeAssetInstanceId} = ${requestedInstanceId})`
            : sql`${schema.documents.scopeAssetInstanceId} IS NULL`,
        ),
      });
      const sortedRows = rows.sort((a, b) => a.orderingHint - b.orderingHint);

      // Sections are loaded only when the caller opts in. Keeps the
      // default response shape byte-identical for any non-PWA consumer.
      const sectionsByDoc = request.query.withSections
        ? await fetchPwaSectionsByDoc(db, sortedRows.map((d) => d.id))
        : null;

      // For field-captures docs, surface the capturing tech's display
      // name so the UNVERIFIED chip can show "captured by Mike P." We
      // fetch the run-owner identity in one batched query (one user
      // lookup instead of N) keyed off the procedure_runs that point
      // back at the doc.
      const isFieldPack = version.pack.kind === 'field_captures';
      const captureIdentities = isFieldPack
        ? await loadCaptureIdentities(db, sortedRows.map((d) => d.id))
        : new Map<string, { userId: string; displayName: string }>();

      return sortedRows.map((d) => {
        const verified = d.fieldVerifiedAt !== null;
        const capture = captureIdentities.get(d.id) ?? null;
        const base = {
          id: d.id,
          kind: d.kind,
          title: d.title,
          language: d.language,
          safetyCritical: d.safetyCritical,
          tags: d.tags,
          hasBody: d.bodyMarkdown !== null,
          storageKey: d.storageKey,
          streamPlaybackId: d.streamPlaybackId,
          externalUrl: d.externalUrl,
          originalFilename: d.originalFilename,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          thumbnailUrl: d.thumbnailStorageKey
            ? storage.publicUrl(d.thumbnailStorageKey)
            : null,
          // Procedure-mode v2 fields. PWA renders the UNVERIFIED chip
          // when source='field' AND verified=false; OEM cards skip this.
          source: isFieldPack ? ('field' as const) : ('oem' as const),
          verified,
          capturedByUserId: capture?.userId ?? null,
          capturedByDisplayName: capture?.displayName ?? null,
          scopeAssetInstanceId: d.scopeAssetInstanceId,
        };
        if (!sectionsByDoc) return base;
        // null = legacy (no authored sections); array (possibly with
        // entries) = sections, post-revalidation filter, sorted.
        const sections: PwaSection[] | null = sectionsByDoc.get(d.id) ?? null;
        return { ...base, sections };
      });
    },
  );

  /**
   * For each doc that's part of a field-captures pack, find the user who
   * captured it. We pick the earliest in_progress|completed|abandoned
   * run owner — that's the authoring tech (the run was created at the
   * same time as the doc). Batched via one IN-list query plus one
   * users-by-ids lookup.
   */
  async function loadCaptureIdentities(
    db: typeof app.ctx.db,
    docIds: string[],
  ): Promise<Map<string, { userId: string; displayName: string }>> {
    const out = new Map<string, { userId: string; displayName: string }>();
    if (docIds.length === 0) return out;
    const runs = await db.query.procedureRuns.findMany({
      where: inArray(schema.procedureRuns.documentId, docIds),
      orderBy: [asc(schema.procedureRuns.startedAt)],
    });
    if (runs.length === 0) return out;
    // First-seen wins per docId — keeps the original capturer.
    const ownerByDoc = new Map<string, string>();
    for (const r of runs) {
      if (!r.documentId) continue;
      if (!ownerByDoc.has(r.documentId)) ownerByDoc.set(r.documentId, r.userId);
    }
    const userIds = [...new Set(ownerByDoc.values())];
    const users = await db.query.users.findMany({
      where: inArray(schema.users.id, userIds),
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    for (const [docId, userId] of ownerByDoc.entries()) {
      const u = userById.get(userId);
      if (u) out.set(docId, { userId, displayName: u.displayName });
    }
    return out;
  }

  // Fetch one document's body (markdown or a URL for uploaded/externally-
  // hosted media). Gated on auth-or-scan; 404s on cross-tenant access so
  // the caller can't probe for existence.
  app.get<{ Params: { id: string } }>(
    '/documents/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: {
          packVersion: { with: { pack: true } },
        },
      });
      if (!doc) return reply.notFound();
      if (
        !scope.all &&
        !scope.orgIds.includes(doc.packVersion.pack.ownerOrganizationId)
      ) {
        return reply.notFound();
      }

      return {
        ...doc,
        fileUrl: doc.storageKey ? storage.publicUrl(doc.storageKey) : null,
        thumbnailUrl: doc.thumbnailStorageKey
          ? storage.publicUrl(doc.thumbnailStorageKey)
          : null,
      };
    },
  );

  // Fetch one section + its parent document body. Used by the voice
  // mode's SectionViewerOverlay — the AI emits [section:UUID] in its
  // streamed answer, and the overlay needs both the section anchor +
  // the doc to render the PDF page (or text excerpt). One round-trip
  // keeps the perceived latency low.
  app.get<{ Params: { id: string } }>(
    '/sections/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuthOrScan(request);
      const scope = await getEffectiveOrgScope(request, db);
      if (!scope) return reply.unauthorized();

      const section = await db.query.documentSections.findFirst({
        where: eq(schema.documentSections.id, request.params.id),
      });
      if (!section) return reply.notFound();
      if (section.needsRevalidation) return reply.notFound();

      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, section.documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      if (
        !scope.all &&
        !scope.orgIds.includes(doc.packVersion.pack.ownerOrganizationId)
      ) {
        return reply.notFound();
      }

      return {
        document: {
          ...doc,
          fileUrl: doc.storageKey ? storage.publicUrl(doc.storageKey) : null,
          thumbnailUrl: doc.thumbnailStorageKey
            ? storage.publicUrl(doc.thumbnailStorageKey)
            : null,
        },
        section: toPwaSection(section),
      };
    },
  );
}
