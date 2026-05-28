// Move a document to a different content pack version. Used to:
//
//   - Rescue a doc from an empty new draft when the author meant to add
//     it to the existing published version.
//   - Reorganize content between versions during pack restructuring.
//
//   POST /admin/documents/:id/move
//   body: { targetVersionId: UUID }
//
// Constraints:
//   - Both versions must belong to the SAME content pack. Cross-pack
//     moves would orphan part links and section anchors that were
//     authored against pack-specific docs. (Admins can re-author there
//     if they really want a cross-pack copy.)
//   - Caller must have scope on the pack's owner org.
//   - Doc's child rows (procedure_steps, document_sections, part links)
//     follow the doc — they reference doc.id, not version.id, so the
//     move is just an UPDATE on documents.content_pack_version_id.

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import { recordAudit } from '../lib/audit.js';

const MoveBody = z.object({
  targetVersionId: UuidSchema,
});

export async function registerAdminDocumentMoveRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: z.infer<typeof MoveBody> }>(
    '/admin/documents/:id/move',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: MoveBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound('Document not found.');
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);

      const target = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.body.targetVersionId),
        with: { pack: true },
      });
      if (!target) return reply.notFound('Target version not found.');

      // Same pack only — moving across packs would orphan org-scoped
      // assumptions and pack-relative authoring; not a path we want
      // accidentally taken from a curl one-liner.
      if (target.contentPackId !== doc.packVersion.contentPackId) {
        return reply.badRequest(
          'Target version must belong to the same content pack as the document.',
        );
      }
      requireOrgInScope(scope, target.pack.ownerOrganizationId);

      // No-op short-circuit so a stale UI click doesn't churn the audit log.
      if (target.id === doc.contentPackVersionId) {
        return reply.send({
          ok: true,
          documentId: doc.id,
          fromVersionId: doc.contentPackVersionId,
          toVersionId: target.id,
          changed: false,
        });
      }

      await db
        .update(schema.documents)
        .set({ contentPackVersionId: target.id })
        .where(eq(schema.documents.id, doc.id));

      await recordAudit(db, request, {
        organizationId: doc.packVersion.pack.ownerOrganizationId,
        eventType: 'document.moved_version',
        targetType: 'document',
        targetId: doc.id,
        payload: {
          fromVersionId: doc.contentPackVersionId,
          fromVersionLabel: doc.packVersion.versionLabel,
          toVersionId: target.id,
          toVersionLabel: target.versionLabel,
          packId: target.contentPackId,
        },
      });

      return reply.send({
        ok: true,
        documentId: doc.id,
        fromVersionId: doc.contentPackVersionId,
        toVersionId: target.id,
        changed: true,
      });
    },
  );
}
