// Duplicate an authored structured procedure into a different content
// pack version. The admin UI offers this from the procedure editor and
// the content-pack detail page; the chooser surfaces only draft versions
// the caller can author into (the duplicate has to land somewhere
// editable).
//
//   POST /admin/procedures/:id/duplicate
//   body: { targetVersionId: UUID, title?: string }
//   →    { documentId, packVersionId, title, stepCount }
//
//   GET  /admin/duplicate-targets
//   →    { targets: [{ packId, packName, ..., versionId, versionNumber,
//                       versionLabel }] }
//
// Copy semantics:
//   - Document fields copy verbatim (body, thumbnail, language, safety,
//     tags, procedureMetadata, ai_indexed). extractionStatus resets to
//     'not_applicable'. localization_group_id gets a fresh value so the
//     duplicate isn't treated as a sibling localization.
//   - Sections + steps + substeps deep-copy with new ids. step.sectionId
//     remaps via the section id map; an orphan step (null sectionId)
//     stays orphan.
//   - linked_procedure_doc_id is preserved as-is — the link still points
//     at a valid document, even if it's in a different pack/version. The
//     author can update if the link no longer makes sense in the target
//     context.
//   - linked_procedure_step_ids copy unchanged (they reference IDs in the
//     LINKED procedure, not in the source procedure being duplicated).
//   - Authored audio storage keys copy by reference (R2 objects are
//     content-addressed; multiple docs can point at the same audio blob).
//   - snippet_id / snippet_detached copy verbatim. Snippets resolve at
//     read time via the snippet-expansion service, which looks up by
//     snippet UUID without org-scope filtering — so the duplicate (even
//     cross-pack) still renders the snippet's current title + blocks.
//     Dropping snippet_id here was the cause of "Untitled step" rows in
//     duplicates of snippet-backed procedures.
//   - category_id copies verbatim. Built-in categories are global; org
//     custom categories will simply fail to resolve in a different org
//     and render with no badge (no breakage, just a missing chip).
//   - proposedByAgentRunId / proposedByDraftRunId are intentionally NOT
//     copied — those are origin-tracking provenance, not content.
//   - part_procedure_steps and document_sections are NOT copied — those
//     are part-link / page-anchor metadata that the author re-curates per
//     duplicate.

import type { FastifyInstance } from 'fastify';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, orgIdsLiteral, requireOrgInScope } from '../middleware/scope.js';
import { recordAudit } from '../lib/audit.js';

const DuplicateBody = z.object({
  targetVersionId: UuidSchema,
  /** Optional title override. Defaults to "Copy of {source.title}". */
  title: z.string().min(1).max(200).optional(),
});

interface TargetRow {
  pack_id: string;
  pack_name: string;
  pack_slug: string;
  layer_type: string;
  asset_model_name: string;
  owner_name: string;
  version_id: string;
  version_number: number;
  version_label: string | null;
  version_status: string;
}

export async function registerAdminProcedureDuplicate(app: FastifyInstance) {
  // GET — enumerate versions the caller can target. Drafts for everyone;
  // published versions also surface for platform admins (mirrors the
  // existing edit-published-version super-admin bypass elsewhere in the
  // admin UI). The chooser tags published rows so the admin knows they're
  // editing live content.
  app.get('/admin/duplicate-targets', async (request, reply) => {
    const { db } = app.ctx;
    const auth = requireAuth(request);
    const scope = await getScope(request, db);
    const scopeLiteral = orgIdsLiteral(scope);
    const statusFilter = auth.platformAdmin
      ? sql`v.status IN ('draft', 'published')`
      : sql`v.status = 'draft'`;

    const rows = (await db.execute(
      scope.all
        ? sql`SELECT p.id AS pack_id, p.name AS pack_name, p.slug AS pack_slug,
                     p.layer_type, am.display_name AS asset_model_name,
                     o.name AS owner_name,
                     v.id AS version_id, v.version_number, v.version_label,
                     v.status::text AS version_status
              FROM content_pack_versions v
              JOIN content_packs p ON p.id = v.content_pack_id
              JOIN asset_models am ON am.id = p.asset_model_id
              JOIN organizations o ON o.id = p.owner_organization_id
              WHERE ${statusFilter}
                AND p.kind = 'authored'
              ORDER BY am.display_name, p.name,
                       CASE v.status WHEN 'draft' THEN 0 ELSE 1 END,
                       v.version_number DESC`
        : sql`SELECT p.id AS pack_id, p.name AS pack_name, p.slug AS pack_slug,
                     p.layer_type, am.display_name AS asset_model_name,
                     o.name AS owner_name,
                     v.id AS version_id, v.version_number, v.version_label,
                     v.status::text AS version_status
              FROM content_pack_versions v
              JOIN content_packs p ON p.id = v.content_pack_id
              JOIN asset_models am ON am.id = p.asset_model_id
              JOIN organizations o ON o.id = p.owner_organization_id
              WHERE ${statusFilter}
                AND p.kind = 'authored'
                AND p.owner_organization_id = ANY(${scopeLiteral}::uuid[])
              ORDER BY am.display_name, p.name,
                       CASE v.status WHEN 'draft' THEN 0 ELSE 1 END,
                       v.version_number DESC`,
    )) as unknown as TargetRow[];

    return reply.send({
      targets: rows.map((r) => ({
        packId: r.pack_id,
        packName: r.pack_name,
        packSlug: r.pack_slug,
        layerType: r.layer_type,
        assetModel: r.asset_model_name,
        owner: r.owner_name,
        versionId: r.version_id,
        versionNumber: r.version_number,
        versionLabel: r.version_label,
        versionStatus: r.version_status,
      })),
    });
  });

  app.post<{ Params: { id: string }; Body: z.infer<typeof DuplicateBody> }>(
    '/admin/procedures/:id/duplicate',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: DuplicateBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const source = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!source) return reply.notFound('Source procedure not found.');
      if (source.kind !== 'structured_procedure') {
        return reply.badRequest(
          'Only structured procedures can be duplicated.',
        );
      }
      requireOrgInScope(scope, source.packVersion.pack.ownerOrganizationId);

      const target = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.body.targetVersionId),
        with: { pack: true },
      });
      if (!target) return reply.notFound('Target version not found.');
      // Drafts: anyone in scope. Published: platform admins only (matches
      // the existing edit-published-version bypass — same pattern the
      // training-module-delete and content-pack-detail UIs use). Archived
      // is always rejected.
      if (target.status === 'archived') {
        return reply.badRequest('Cannot duplicate into an archived version.');
      }
      if (target.status === 'published' && !auth.platformAdmin) {
        return reply.badRequest(
          'Duplicates into a published version require platform-admin access. Create a draft on the target pack first.',
        );
      }
      requireOrgInScope(scope, target.pack.ownerOrganizationId);

      const newTitle =
        request.body.title?.trim() || `Copy of ${source.title}`;

      const sections = await db.query.procedureSections.findMany({
        where: eq(schema.procedureSections.documentId, source.id),
        orderBy: [asc(schema.procedureSections.orderingHint)],
      });
      const steps = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, source.id),
        orderBy: [asc(schema.procedureSteps.orderingHint)],
      });
      const stepIds = steps.map((s) => s.id);
      const substeps =
        stepIds.length > 0
          ? await db.query.procedureSubsteps.findMany({
              where: inArray(
                schema.procedureSubsteps.procedureStepId,
                stepIds,
              ),
              orderBy: [asc(schema.procedureSubsteps.orderingHint)],
            })
          : [];

      const [newDoc] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: target.id,
          kind: 'structured_procedure',
          title: newTitle,
          bodyMarkdown: source.bodyMarkdown,
          thumbnailStorageKey: source.thumbnailStorageKey,
          language: source.language,
          safetyCritical: source.safetyCritical,
          aiIndexed: source.aiIndexed,
          orderingHint: source.orderingHint,
          tags: source.tags,
          extractionStatus: 'not_applicable',
          procedureMetadata: source.procedureMetadata,
        })
        .returning();
      if (!newDoc) {
        return reply.internalServerError('Failed to create duplicate document.');
      }

      // Section id mapping (old → new). Empty when the source had no
      // sections; legacy procedures with orphan steps still work.
      const sectionIdMap: Record<string, string> = {};
      for (const s of sections) {
        const [created] = await db
          .insert(schema.procedureSections)
          .values({
            documentId: newDoc.id,
            title: s.title,
            description: s.description,
            orderingHint: s.orderingHint,
            createdByUserId: auth.userId,
          })
          .returning({ id: schema.procedureSections.id });
        if (created) sectionIdMap[s.id] = created.id;
      }

      const stepIdMap: Record<string, string> = {};
      for (const step of steps) {
        const newSectionId = step.sectionId
          ? sectionIdMap[step.sectionId] ?? null
          : null;
        const [created] = await db
          .insert(schema.procedureSteps)
          .values({
            documentId: newDoc.id,
            sectionId: newSectionId,
            linkedProcedureDocId: step.linkedProcedureDocId,
            linkedProcedureStepIds: step.linkedProcedureStepIds,
            kind: step.kind,
            title: step.title,
            bodyMarkdown: step.bodyMarkdown,
            safetyCritical: step.safetyCritical,
            orderingHint: step.orderingHint,
            requiresPhoto: step.requiresPhoto,
            minPhotoCount: step.minPhotoCount,
            measurementSpec: step.measurementSpec,
            media: step.media,
            blocks: step.blocks,
            audioStorageKey: step.audioStorageKey,
            audioContentType: step.audioContentType,
            audioSizeBytes: step.audioSizeBytes,
            audioDurationMs: step.audioDurationMs,
            audioSource: step.audioSource,
            // Snippet reference — preserve so the duplicate inherits the
            // snippet's resolved title + blocks via snippet-expansion at
            // read time. Without this, snippet-backed steps in the
            // duplicate render as "Untitled step" (the step row has no
            // own-title, and there's no snippet to resolve from).
            snippetId: step.snippetId,
            snippetDetached: step.snippetDetached,
            // Per-step category override (independent of section category).
            // Built-in categories are global so this always resolves;
            // org-custom categories in a different target org render
            // without a badge (no breakage, just missing chip).
            categoryId: step.categoryId,
            createdByUserId: auth.userId,
          })
          .returning({ id: schema.procedureSteps.id });
        if (created) stepIdMap[step.id] = created.id;
      }

      for (const ss of substeps) {
        const newStepId = stepIdMap[ss.procedureStepId];
        if (!newStepId) continue;
        await db.insert(schema.procedureSubsteps).values({
          procedureStepId: newStepId,
          title: ss.title,
          bodyMarkdown: ss.bodyMarkdown,
          orderingHint: ss.orderingHint,
          createdByUserId: auth.userId,
        });
      }

      await recordAudit(db, request, {
        organizationId: target.pack.ownerOrganizationId,
        eventType: 'procedure.duplicated',
        targetType: 'document',
        targetId: newDoc.id,
        payload: {
          sourceDocumentId: source.id,
          sourceVersionId: source.contentPackVersionId,
          sourcePackId: source.packVersion.pack.id,
          targetVersionId: target.id,
          targetPackId: target.pack.id,
          sectionCount: sections.length,
          stepCount: steps.length,
          substepCount: substeps.length,
        },
      });

      return reply.send({
        documentId: newDoc.id,
        packVersionId: target.id,
        title: newTitle,
        stepCount: steps.length,
      });
    },
  );
}
