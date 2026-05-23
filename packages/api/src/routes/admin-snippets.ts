// Admin authoring API for procedure_snippets — reusable step content
// (Lockout-Tagout, Safety Briefing, etc.) referenced from procedure_steps.
//
// Surface:
//   GET    /admin/snippets                       (list with filters)
//   GET    /admin/snippets/:id                   (full + referenceCount)
//   GET    /admin/snippets/:id/revisions         (history; paginated)
//   POST   /admin/snippets                       (create; isPlatform requires admin)
//   PATCH  /admin/snippets/:id                   (update; writes revision row)
//   DELETE /admin/snippets/:id                   (409 if non-detached references)
//
// Tiers:
//   isPlatform=false → org-scoped. owner_organization_id required. Writes
//     require the org to be in the caller's scope.
//   isPlatform=true  → global (SANTECH-published). Writes require
//     request.auth.platformAdmin. Reads visible to every authenticated user
//     so any org's author can insert them into a procedure.
//
// Propagation audit:
//   When a platform snippet is PATCHed, every (org, contentPackVersionId)
//   pair holding a non-detached referencing step receives an audit_events
//   row of type 'procedure_snippet.platform_propagated'. Lets affected
//   customer admins see "SANTECH updated LOTO and your procedures changed."

import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { z } from 'zod';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope, type Scope } from '../middleware/scope.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

// Block discriminated union mirrors the procedure_steps schema exactly.
// Keep this in sync with packages/api/src/routes/admin-procedure-steps.ts
// (the source of truth) — both files validate the same StepBlock shape.
const ParagraphBlock = z.object({
  kind: z.literal('paragraph'),
  text: z.string().max(8000),
});
const CalloutBlock = z.object({
  kind: z.literal('callout'),
  tone: z.enum(['safety', 'warning', 'tip', 'note']),
  title: z.string().max(120).optional(),
  // Permissive on write — the editor inserts blocks empty and the
  // debounced auto-save would otherwise 400 on a freshly-added block
  // before the author types into it. Empty text renders as nothing in
  // the runner, which is the same behavior as an empty paragraph block.
  text: z.string().max(2000),
});
const BulletListBlock = z.object({
  kind: z.literal('bullet_list'),
  items: z.array(z.string().max(800)).max(50),
});
const NumberedListBlock = z.object({
  kind: z.literal('numbered_list'),
  items: z.array(z.string().max(800)).max(50),
});
const KeyValueBlock = z.object({
  kind: z.literal('key_value'),
  columns: z.tuple([z.string().max(60), z.string().max(60)]),
  rows: z.array(z.tuple([z.string().max(200), z.string().max(200)])).max(60),
});
const PhotoInlineBlock = z.object({
  kind: z.literal('photo_inline'),
  storageKey: z.string().min(1).max(400),
  caption: z.string().max(400).optional(),
});
const StepBlockSchema = z.discriminatedUnion('kind', [
  ParagraphBlock,
  CalloutBlock,
  BulletListBlock,
  NumberedListBlock,
  KeyValueBlock,
  PhotoInlineBlock,
]);
const BlocksArraySchema = z.array(StepBlockSchema).max(40);

const SnippetKindEnum = z.enum([
  'instruction',
  'safety_check',
  'photo_required',
  'measurement_required',
]);

const SnippetCreateBody = z.object({
  title: z.string().min(1).max(200),
  kind: SnippetKindEnum.default('instruction'),
  blocks: BlocksArraySchema.default([]),
  tags: z.array(z.string().max(60)).max(20).default([]),
  isPlatform: z.boolean().optional(),
  /** Required when isPlatform=false. Ignored when isPlatform=true. */
  ownerOrganizationId: UuidSchema.nullable().optional(),
});

const SnippetPatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    kind: SnippetKindEnum.optional(),
    blocks: BlocksArraySchema.optional(),
    tags: z.array(z.string().max(60)).max(20).optional(),
    changeNote: z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  kind: SnippetKindEnum.optional(),
  /** Filter by org. Defaults to: caller's scope orgs + platform snippets.
   *  Pass an explicit orgId to narrow. */
  ownerOrganizationId: UuidSchema.nullable().optional(),
  /** When true (default), include is_platform=true rows in the result. */
  includePlatform: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const RevisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type SnippetRow = typeof schema.procedureSnippets.$inferSelect;
type SnippetRevisionRow = typeof schema.procedureSnippetRevisions.$inferSelect;

function snippetToListDTO(row: SnippetRow) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    isPlatform: row.isPlatform,
    ownerOrganizationId: row.ownerOrganizationId,
    tags: row.tags,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snippetToDetailDTO(
  row: SnippetRow,
  extras: {
    referenceCount: number;
    referencesPreview: Array<{
      stepId: string;
      stepTitle: string;
      documentId: string;
      documentTitle: string;
      ownerOrganizationId: string;
    }>;
    audioUrl: string | null;
  },
) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    blocks: row.blocks,
    tags: row.tags,
    isPlatform: row.isPlatform,
    ownerOrganizationId: row.ownerOrganizationId,
    audioStorageKey: row.audioStorageKey,
    audioContentType: row.audioContentType,
    audioSizeBytes: row.audioSizeBytes,
    audioDurationMs: row.audioDurationMs,
    audioSource: row.audioSource,
    audioUrl: extras.audioUrl,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    referenceCount: extras.referenceCount,
    referencesPreview: extras.referencesPreview,
  };
}

function revisionToDTO(row: SnippetRevisionRow) {
  return {
    id: row.id,
    snippetId: row.snippetId,
    revisionNumber: row.revisionNumber,
    title: row.title,
    blocks: row.blocks,
    changeNote: row.changeNote,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/**
 * Throw 404 if the caller cannot READ this snippet.
 *
 * Read visibility:
 *   - is_platform=true → visible to everyone authenticated.
 *   - org-scoped       → visible if owner org is in caller's scope.
 *
 * 404 (not 403) matches the rest of the API — a scoped caller probing
 * unknown IDs should not be able to distinguish "exists elsewhere" from
 * "doesn't exist."
 */
function requireSnippetReadable(snippet: SnippetRow, scope: Scope): void {
  if (snippet.isPlatform) return;
  if (!snippet.ownerOrganizationId) {
    throw httpError(500, 'snippet has no owner');
  }
  requireOrgInScope(scope, snippet.ownerOrganizationId);
}

/**
 * Throw 403/404 if the caller cannot WRITE this snippet.
 *
 * Write authority:
 *   - is_platform=true → requires request.auth.platformAdmin.
 *   - org-scoped       → requires owner org in caller's scope (which is
 *                        also true for platform admins via scope.all).
 */
function requireSnippetWritable(
  snippet: SnippetRow,
  scope: Scope,
  auth: { platformAdmin?: boolean },
): void {
  if (snippet.isPlatform) {
    if (!auth.platformAdmin) {
      throw httpError(403, 'Platform snippets can only be edited by platform admins.');
    }
    return;
  }
  if (!snippet.ownerOrganizationId) {
    throw httpError(500, 'snippet has no owner');
  }
  requireOrgInScope(scope, snippet.ownerOrganizationId);
}

function httpError(code: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = code;
  return err;
}

// ---------------------------------------------------------------------------
// Reverse-lookup helpers
// ---------------------------------------------------------------------------

/**
 * Count non-detached steps referencing this snippet. Detached references
 * don't count — they've drifted independently and don't gate delete.
 */
async function countActiveReferences(db: Database, snippetId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.procedureSteps)
    .where(
      and(
        eq(schema.procedureSteps.snippetId, snippetId),
        eq(schema.procedureSteps.snippetDetached, false),
      ),
    );
  return Number(row?.n ?? 0);
}

interface ReferencePreview {
  stepId: string;
  stepTitle: string;
  documentId: string;
  documentTitle: string;
  ownerOrganizationId: string;
  contentPackVersionId: string;
}

/**
 * Sample of up to `limit` references, joined to documents → packVersion →
 * pack so the detail page can show org + doc context per row. Skips
 * detached references entirely (same logic as countActiveReferences).
 */
async function loadReferenceSample(
  db: Database,
  snippetId: string,
  limit = 10,
): Promise<ReferencePreview[]> {
  const rows = await db
    .select({
      stepId: schema.procedureSteps.id,
      stepTitle: schema.procedureSteps.title,
      documentId: schema.documents.id,
      documentTitle: schema.documents.title,
      ownerOrganizationId: schema.contentPacks.ownerOrganizationId,
      contentPackVersionId: schema.documents.contentPackVersionId,
    })
    .from(schema.procedureSteps)
    .innerJoin(
      schema.documents,
      eq(schema.procedureSteps.documentId, schema.documents.id),
    )
    .innerJoin(
      schema.contentPackVersions,
      eq(schema.documents.contentPackVersionId, schema.contentPackVersions.id),
    )
    .innerJoin(
      schema.contentPacks,
      eq(schema.contentPackVersions.contentPackId, schema.contentPacks.id),
    )
    .where(
      and(
        eq(schema.procedureSteps.snippetId, snippetId),
        eq(schema.procedureSteps.snippetDetached, false),
      ),
    )
    .orderBy(desc(schema.procedureSteps.updatedAt))
    .limit(limit);
  return rows;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminSnippets(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /admin/snippets — list
  // -------------------------------------------------------------------------
  app.get<{ Querystring: z.infer<typeof ListQuery> }>(
    '/admin/snippets',
    { schema: { querystring: ListQuery } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const q = request.query;

      // Compose the visibility predicate. Caller sees: (a) snippets owned
      // by orgs in their scope; (b) platform snippets if includePlatform.
      // Platform admins (scope.all) see everything.
      const filters = [];
      if (!scope.all) {
        const orgPredicates = [];
        if (scope.orgIds.length > 0) {
          orgPredicates.push(
            inArray(schema.procedureSnippets.ownerOrganizationId, scope.orgIds),
          );
        }
        if (q.includePlatform) {
          orgPredicates.push(eq(schema.procedureSnippets.isPlatform, true));
        }
        if (orgPredicates.length === 0) {
          return [];
        }
        filters.push(or(...orgPredicates)!);
      } else if (!q.includePlatform) {
        filters.push(eq(schema.procedureSnippets.isPlatform, false));
      }
      if (q.ownerOrganizationId !== undefined) {
        if (q.ownerOrganizationId === null) {
          filters.push(isNull(schema.procedureSnippets.ownerOrganizationId));
        } else {
          // Caller can narrow to a specific org but only if it's in scope.
          requireOrgInScope(scope, q.ownerOrganizationId);
          filters.push(
            eq(schema.procedureSnippets.ownerOrganizationId, q.ownerOrganizationId),
          );
        }
      }
      if (q.kind) filters.push(eq(schema.procedureSnippets.kind, q.kind));
      if (q.q && q.q.length > 0) {
        filters.push(ilike(schema.procedureSnippets.title, `%${q.q}%`));
      }

      const rows = await db.query.procedureSnippets.findMany({
        where: filters.length > 0 ? and(...filters) : undefined,
        orderBy: [
          // Platform snippets first, then alpha by title. Lets the picker
          // render the "Global" section above org snippets without an
          // extra client-side sort.
          desc(schema.procedureSnippets.isPlatform),
          asc(schema.procedureSnippets.title),
        ],
        limit: q.limit,
        offset: q.offset,
      });
      return rows.map(snippetToListDTO);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/snippets/:id — full detail + reference summary
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/admin/snippets/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const snippet = await db.query.procedureSnippets.findFirst({
        where: eq(schema.procedureSnippets.id, request.params.id),
      });
      if (!snippet) return reply.notFound();
      requireSnippetReadable(snippet, scope);

      const [referenceCount, referencesPreview] = await Promise.all([
        countActiveReferences(db, snippet.id),
        loadReferenceSample(db, snippet.id, 10),
      ]);
      const audioUrl = snippet.audioStorageKey
        ? storage.publicUrl(snippet.audioStorageKey)
        : null;
      return snippetToDetailDTO(snippet, {
        referenceCount,
        referencesPreview,
        audioUrl,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/snippets/:id/revisions
  // -------------------------------------------------------------------------
  app.get<{
    Params: { id: string };
    Querystring: z.infer<typeof RevisionsQuery>;
  }>(
    '/admin/snippets/:id/revisions',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        querystring: RevisionsQuery,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const snippet = await db.query.procedureSnippets.findFirst({
        where: eq(schema.procedureSnippets.id, request.params.id),
      });
      if (!snippet) return reply.notFound();
      requireSnippetReadable(snippet, scope);

      const rows = await db.query.procedureSnippetRevisions.findMany({
        where: eq(schema.procedureSnippetRevisions.snippetId, snippet.id),
        orderBy: [desc(schema.procedureSnippetRevisions.revisionNumber)],
        limit: request.query.limit,
        offset: request.query.offset,
      });
      return rows.map(revisionToDTO);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/snippets — create
  // -------------------------------------------------------------------------
  app.post<{ Body: z.infer<typeof SnippetCreateBody> }>(
    '/admin/snippets',
    { schema: { body: SnippetCreateBody } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const body = request.body;
      const isPlatform = body.isPlatform === true;

      if (isPlatform) {
        if (!auth.platformAdmin) {
          return reply
            .code(403)
            .send({
              statusCode: 403,
              error: 'Forbidden',
              message: 'Platform snippets require platform admin.',
            });
        }
      } else {
        if (!body.ownerOrganizationId) {
          return reply.badRequest(
            'ownerOrganizationId is required when isPlatform=false.',
          );
        }
        requireOrgInScope(scope, body.ownerOrganizationId);
      }

      const [row] = await db
        .insert(schema.procedureSnippets)
        .values({
          ownerOrganizationId: isPlatform ? null : body.ownerOrganizationId!,
          isPlatform,
          title: body.title,
          kind: body.kind,
          blocks: body.blocks,
          tags: body.tags,
          createdByUserId: auth.userId,
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create snippet.');

      // Initial revision row — captures the seed content for the history tab.
      await db.insert(schema.procedureSnippetRevisions).values({
        snippetId: row.id,
        revisionNumber: 1,
        title: row.title,
        blocks: row.blocks,
        changeNote: 'Initial revision',
        createdByUserId: auth.userId,
      });

      // Audit event. Platform-snippet creation is attributed to the
      // creator's home org (organizations.NOT NULL constraint on
      // audit_events.organization_id leaves us no choice for a snippet
      // whose owner_organization_id is null).
      const auditOrgId = isPlatform ? auth.organizationId : body.ownerOrganizationId!;
      await db.insert(schema.auditEvents).values({
        organizationId: auditOrgId,
        actorUserId: auth.userId,
        eventType: 'procedure_snippet.created',
        targetType: 'procedure_snippet',
        targetId: row.id,
        payload: {
          title: row.title,
          kind: row.kind,
          isPlatform: row.isPlatform,
          ownerOrganizationId: row.ownerOrganizationId,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.code(201).send(
        snippetToDetailDTO(row, {
          referenceCount: 0,
          referencesPreview: [],
          audioUrl: null,
        }),
      );
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/snippets/:id — update + write revision + propagation audit
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: z.infer<typeof SnippetPatchBody>;
  }>(
    '/admin/snippets/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: SnippetPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const existing = await db.query.procedureSnippets.findFirst({
        where: eq(schema.procedureSnippets.id, request.params.id),
      });
      if (!existing) return reply.notFound();
      requireSnippetWritable(existing, scope, auth);

      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = b.title;
      if (b.kind !== undefined) patch.kind = b.kind;
      if (b.blocks !== undefined) patch.blocks = b.blocks;
      if (b.tags !== undefined) patch.tags = b.tags;

      const [updated] = await db
        .update(schema.procedureSnippets)
        .set(patch)
        .where(eq(schema.procedureSnippets.id, existing.id))
        .returning();
      if (!updated) return reply.internalServerError('Update failed.');

      // Append a revision row capturing the post-patch state. revision_number
      // = max + 1 per snippet. The unique constraint on (snippet_id,
      // revision_number) guarantees monotonicity even under racing PATCHes.
      const [maxRev] = await db
        .select({ n: sql<number>`coalesce(max(${schema.procedureSnippetRevisions.revisionNumber}), 0)` })
        .from(schema.procedureSnippetRevisions)
        .where(eq(schema.procedureSnippetRevisions.snippetId, existing.id));
      const nextRevisionNumber = Number(maxRev?.n ?? 0) + 1;
      await db.insert(schema.procedureSnippetRevisions).values({
        snippetId: existing.id,
        revisionNumber: nextRevisionNumber,
        title: updated.title,
        blocks: updated.blocks,
        changeNote: b.changeNote ?? null,
        createdByUserId: auth.userId,
      });

      // Audit on the snippet itself.
      const auditOrgId = existing.isPlatform
        ? auth.organizationId
        : existing.ownerOrganizationId!;
      await db.insert(schema.auditEvents).values({
        organizationId: auditOrgId,
        actorUserId: auth.userId,
        eventType: 'procedure_snippet.updated',
        targetType: 'procedure_snippet',
        targetId: updated.id,
        payload: {
          fields: Object.keys(b),
          revisionNumber: nextRevisionNumber,
          isPlatform: updated.isPlatform,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      // Platform-snippet cross-org propagation: emit one audit row per
      // affected (org, contentPackVersionId) so each customer admin can
      // see "SANTECH updated LOTO and X procedures in your published packs
      // changed."
      if (existing.isPlatform) {
        const affected = await db
          .select({
            organizationId: schema.contentPacks.ownerOrganizationId,
            contentPackVersionId: schema.documents.contentPackVersionId,
            stepCount: count(),
          })
          .from(schema.procedureSteps)
          .innerJoin(
            schema.documents,
            eq(schema.procedureSteps.documentId, schema.documents.id),
          )
          .innerJoin(
            schema.contentPackVersions,
            eq(schema.documents.contentPackVersionId, schema.contentPackVersions.id),
          )
          .innerJoin(
            schema.contentPacks,
            eq(schema.contentPackVersions.contentPackId, schema.contentPacks.id),
          )
          .where(
            and(
              eq(schema.procedureSteps.snippetId, existing.id),
              eq(schema.procedureSteps.snippetDetached, false),
            ),
          )
          .groupBy(
            schema.contentPacks.ownerOrganizationId,
            schema.documents.contentPackVersionId,
          );

        if (affected.length > 0) {
          await db.insert(schema.auditEvents).values(
            affected.map((a) => ({
              organizationId: a.organizationId,
              actorUserId: auth.userId,
              eventType: 'procedure_snippet.platform_propagated',
              targetType: 'procedure_snippet',
              targetId: updated.id,
              payload: {
                snippetId: updated.id,
                snippetTitle: updated.title,
                revisionNumber: nextRevisionNumber,
                contentPackVersionId: a.contentPackVersionId,
                affectedStepCount: Number(a.stepCount),
              },
              ipAddress: request.ip,
              userAgent: request.headers['user-agent'] ?? null,
            })),
          );
        }
      }

      const [referenceCount, referencesPreview] = await Promise.all([
        countActiveReferences(db, updated.id),
        loadReferenceSample(db, updated.id, 10),
      ]);
      const audioUrl = updated.audioStorageKey
        ? app.ctx.storage.publicUrl(updated.audioStorageKey)
        : null;
      return snippetToDetailDTO(updated, {
        referenceCount,
        referencesPreview,
        audioUrl,
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/snippets/:id
  //
  // Refuse if any non-detached steps reference this snippet. The author
  // must either detach those steps or remove the references first.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/admin/snippets/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const existing = await db.query.procedureSnippets.findFirst({
        where: eq(schema.procedureSnippets.id, request.params.id),
      });
      if (!existing) return reply.notFound();
      requireSnippetWritable(existing, scope, auth);

      const refs = await loadReferenceSample(db, existing.id, 25);
      if (refs.length > 0) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `Snippet has ${refs.length === 25 ? '25+' : refs.length} active reference(s). Detach those steps before deleting.`,
          references: refs,
        });
      }

      await db
        .delete(schema.procedureSnippets)
        .where(eq(schema.procedureSnippets.id, existing.id));

      const auditOrgId = existing.isPlatform
        ? auth.organizationId
        : existing.ownerOrganizationId!;
      await db.insert(schema.auditEvents).values({
        organizationId: auditOrgId,
        actorUserId: auth.userId,
        eventType: 'procedure_snippet.deleted',
        targetType: 'procedure_snippet',
        targetId: existing.id,
        payload: {
          title: existing.title,
          isPlatform: existing.isPlatform,
          ownerOrganizationId: existing.ownerOrganizationId,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );
}
