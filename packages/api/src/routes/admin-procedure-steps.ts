// Admin authoring API for procedure_steps. Mirrors admin-sections.ts.
//
// Surface:
//   GET    /admin/documents/:documentId/procedure-steps
//   POST   /admin/documents/:documentId/procedure-steps
//   PATCH  /admin/procedure-steps/:stepId
//   DELETE /admin/procedure-steps/:stepId          (409 if completions exist)
//   GET    /admin/procedure-steps/:stepId/parts
//   PUT    /admin/procedure-steps/:stepId/parts    (set-replace)
//   POST   /admin/documents/:documentId/procedure-steps/reorder
//
// All writes are scoped to the document's owner org. Steps are additive
// overlays (like sections) — edits are allowed on published versions so
// authors can keep improving procedures without bumping the pack version.

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import { z } from 'zod';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';
import {
  expandStep,
  loadSnippetMap,
  type SnippetBadge,
} from '../services/snippet-expansion.js';

// ---------------------------------------------------------------------------
// Zod schemas — request bodies
// ---------------------------------------------------------------------------

const StepKindEnum = z.enum([
  'instruction',
  'safety_check',
  'photo_required',
  'measurement_required',
]);

// Discriminated union for measurement specs. Keep schemas in sync with
// the runtime check in packages/api/src/routes/procedures.ts and the
// MeasurementSpec type in packages/db/src/schema/procedures.ts.
const NumericSpec = z.object({
  kind: z.literal('numeric'),
  label: z.string().min(1).max(120),
  unit: z.string().min(1).max(40),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  expected: z.number().nullable().optional(),
  tolerancePct: z.number().nullable().optional(),
});
const PassFailSpec = z.object({
  kind: z.literal('pass_fail'),
  label: z.string().min(1).max(120),
  passLabel: z.string().max(40).optional(),
  failLabel: z.string().max(40).optional(),
});
const FreeTextSpec = z.object({
  kind: z.literal('free_text'),
  label: z.string().min(1).max(120),
  placeholder: z.string().max(120).optional(),
  maxLen: z.number().int().min(1).max(2000).optional(),
});
const MeasurementSpecSchema = z.discriminatedUnion('kind', [
  NumericSpec,
  PassFailSpec,
  FreeTextSpec,
]);

// Discriminated union for typed step blocks. Mirrors StepBlock in
// packages/db/src/schema/procedures.ts. Server validates the shape so a
// rogue admin client can't persist incoherent rows.
const ParagraphBlock = z.object({
  kind: z.literal('paragraph'),
  text: z.string().max(8000),
});
const CalloutBlock = z.object({
  kind: z.literal('callout'),
  tone: z.enum(['safety', 'warning', 'tip', 'note']),
  title: z.string().max(120).optional(),
  text: z.string().min(1).max(2000),
});
const BulletListBlock = z.object({
  kind: z.literal('bullet_list'),
  items: z.array(z.string().min(1).max(800)).min(1).max(50),
});
const NumberedListBlock = z.object({
  kind: z.literal('numbered_list'),
  items: z.array(z.string().min(1).max(800)).min(1).max(50),
});
const KeyValueBlock = z.object({
  kind: z.literal('key_value'),
  columns: z.tuple([z.string().min(1).max(60), z.string().min(1).max(60)]),
  rows: z
    .array(z.tuple([z.string().min(1).max(200), z.string().min(1).max(200)]))
    .min(1)
    .max(60),
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

const StepCreateBody = z
  .object({
    kind: StepKindEnum,
    // Allow empty titles on create — the CMS pattern is to add an empty
    // step card the user types into inline. The runner renders "Untitled
    // step" when blank so the row is still scannable.
    title: z.string().max(200),
    bodyMarkdown: z.string().max(10000).nullable().optional(),
    safetyCritical: z.boolean().optional(),
    orderingHint: z.number().int().optional(),
    // Optional section grouping. Server validates that sectionId belongs to
    // the same document. Null = orphan step (renders above first section).
    sectionId: UuidSchema.nullable().optional(),
    // Optional sub-procedure link. Validated below to be a structured_procedure
    // doc in the same content pack version.
    linkedProcedureDocId: UuidSchema.nullable().optional(),
    // Optional subset of steps from the linked sub-procedure to play.
    // Validated below to belong to the linked doc. Empty / omitted =
    // play the full procedure.
    linkedProcedureStepIds: z.array(UuidSchema).max(100).optional(),
    requiresPhoto: z.boolean().optional(),
    minPhotoCount: z.number().int().min(0).max(10).optional(),
    measurementSpec: MeasurementSpecSchema.nullable().optional(),
    blocks: BlocksArraySchema.optional(),
    // Reusable snippet reference. When set, the step's content is resolved
    // at read time from procedure_snippets (always-latest). Title and
    // blocks may still be supplied on create — when title is provided it
    // becomes a per-step override; when blocks are provided they're
    // ignored at read time as long as snippet_detached=false.
    snippetId: UuidSchema.nullable().optional(),
  })
  .refine(
    (b) =>
      b.kind !== 'measurement_required' || b.measurementSpec != null,
    { message: 'measurement_required steps must include a measurementSpec.' },
  )
  .refine(
    (b) =>
      b.kind !== 'photo_required' ||
      ((b.requiresPhoto ?? false) && (b.minPhotoCount ?? 0) >= 1),
    { message: 'photo_required steps must set requiresPhoto and minPhotoCount >= 1.' },
  );

const StepPatchBody = z
  .object({
    kind: StepKindEnum.optional(),
    title: z.string().max(200).optional(),
    bodyMarkdown: z.string().max(10000).nullable().optional(),
    safetyCritical: z.boolean().optional(),
    orderingHint: z.number().int().optional(),
    // Move a step between sections (or to orphan with null).
    sectionId: UuidSchema.nullable().optional(),
    // Re-target / clear the sub-procedure link.
    linkedProcedureDocId: UuidSchema.nullable().optional(),
    // Patch the step subset (empty array = play full linked procedure).
    linkedProcedureStepIds: z.array(UuidSchema).max(100).optional(),
    requiresPhoto: z.boolean().optional(),
    minPhotoCount: z.number().int().min(0).max(10).optional(),
    measurementSpec: MeasurementSpecSchema.nullable().optional(),
    blocks: BlocksArraySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

const ReorderBody = z.object({
  orderedIds: z.array(UuidSchema).min(1),
});

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type StepRow = typeof schema.procedureSteps.$inferSelect;

function rowToDTO(
  row: StepRow,
  opts?: {
    audioPublicUrl?: string | null;
    mediaPublicUrl?: (storageKey: string) => string;
    /** Override for blocks/title after snippet expansion. When set, these
     *  replace the row's own blocks/title in the returned DTO. */
    expanded?: { blocks: StepRow['blocks']; title: string };
    /** Snippet provenance badge — set when the step references a snippet. */
    snippetBadge?: SnippetBadge | null;
  },
) {
  // Expand each media item with a publicly-resolvable URL so the admin
  // editor and PWA runner can render thumbnails without a second round-
  // trip per item.
  const media = (row.media ?? []).map((m) => ({
    ...m,
    url: opts?.mediaPublicUrl ? opts.mediaPublicUrl(m.storageKey) : null,
  }));
  const blocks = opts?.expanded ? opts.expanded.blocks : (row.blocks ?? []);
  const title = opts?.expanded ? opts.expanded.title : row.title;
  return {
    id: row.id,
    documentId: row.documentId,
    sectionId: row.sectionId,
    linkedProcedureDocId: row.linkedProcedureDocId,
    linkedProcedureStepIds: row.linkedProcedureStepIds ?? [],
    kind: row.kind,
    title,
    bodyMarkdown: row.bodyMarkdown,
    safetyCritical: row.safetyCritical,
    orderingHint: row.orderingHint,
    requiresPhoto: row.requiresPhoto,
    minPhotoCount: row.minPhotoCount,
    measurementSpec: row.measurementSpec,
    blocks,
    media,
    audioStorageKey: row.audioStorageKey,
    audioContentType: row.audioContentType,
    audioSizeBytes: row.audioSizeBytes,
    audioDurationMs: row.audioDurationMs,
    audioSource: row.audioSource,
    audioUrl: opts?.audioPublicUrl ?? null,
    snippetId: row.snippetId,
    snippetDetached: row.snippetDetached,
    snippetBadge: opts?.snippetBadge ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Project a list of step rows through snippet expansion. Returns the same
 * length-array of DTOs in the same order, with each DTO carrying the
 * resolved blocks/title and a snippetBadge when a snippet is attached.
 */
async function rowsToExpandedDTO(
  db: Database,
  rows: StepRow[],
  ctx: {
    audioPublicUrl: (storageKey: string) => string;
    mediaPublicUrl: (storageKey: string) => string;
  },
): Promise<ReturnType<typeof rowToDTO>[]> {
  const snippetMap = await loadSnippetMap(
    db,
    rows.map((r) => r.snippetId),
  );
  return rows.map((r) => {
    const expanded = expandStep(
      {
        snippetId: r.snippetId,
        snippetDetached: r.snippetDetached,
        title: r.title,
        blocks: r.blocks ?? [],
      },
      snippetMap,
    );
    return rowToDTO(r, {
      audioPublicUrl: r.audioStorageKey ? ctx.audioPublicUrl(r.audioStorageKey) : null,
      mediaPublicUrl: ctx.mediaPublicUrl,
      expanded: { blocks: expanded.blocks, title: expanded.title },
      snippetBadge: expanded._snippetBadge,
    });
  });
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
  };
}

async function loadStepForWrite(
  db: Database,
  stepId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<{
  step: StepRow;
  doc: typeof schema.documents.$inferSelect;
  ownerOrganizationId: string;
} | null> {
  const step = await db.query.procedureSteps.findFirst({
    where: eq(schema.procedureSteps.id, stepId),
  });
  if (!step) return null;
  const ctx = await loadDocumentForWrite(db, step.documentId, scope);
  if (!ctx) return null;
  return { step, ...ctx };
}

/**
 * Coerce evidence-required flags into a coherent state. The CHECK
 * constraints on the table reject incoherent rows, but this helper
 * lets the route surface a clearer 400 message before the DB rejects.
 */
function coerceEvidence(input: {
  kind: StepRow['kind'];
  requiresPhoto: boolean | undefined;
  minPhotoCount: number | undefined;
  measurementSpec: StepRow['measurementSpec'] | undefined;
}): {
  requiresPhoto: boolean;
  minPhotoCount: number;
  measurementSpec: StepRow['measurementSpec'];
} {
  if (input.kind === 'photo_required') {
    return {
      requiresPhoto: true,
      minPhotoCount: Math.max(1, input.minPhotoCount ?? 1),
      measurementSpec: null,
    };
  }
  if (input.kind === 'measurement_required') {
    return {
      requiresPhoto: input.requiresPhoto ?? false,
      minPhotoCount: input.minPhotoCount ?? 0,
      measurementSpec: input.measurementSpec ?? null,
    };
  }
  // instruction / safety_check
  return {
    requiresPhoto: input.requiresPhoto ?? false,
    minPhotoCount: input.minPhotoCount ?? 0,
    measurementSpec: null,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminProcedureSteps(app: FastifyInstance) {
  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId/procedure-steps
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/procedure-steps',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const rows = await db.query.procedureSteps.findMany({
        where: eq(schema.procedureSteps.documentId, request.params.documentId),
        orderBy: [
          asc(schema.procedureSteps.orderingHint),
          asc(schema.procedureSteps.createdAt),
        ],
      });
      return rowsToExpandedDTO(db, rows, {
        audioPublicUrl: (k) => storage.publicUrl(k),
        mediaPublicUrl: (k) => storage.publicUrl(k),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/procedure-steps — create
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: z.infer<typeof StepCreateBody>;
  }>(
    '/admin/documents/:documentId/procedure-steps',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: StepCreateBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();
      if (ctx.doc.kind !== 'structured_procedure') {
        return reply.badRequest(
          'Steps can only be authored on structured_procedure documents.',
        );
      }
      const body = request.body;
      const evidence = coerceEvidence({
        kind: body.kind,
        requiresPhoto: body.requiresPhoto,
        minPhotoCount: body.minPhotoCount,
        measurementSpec: body.measurementSpec ?? null,
      });

      // If a sectionId is provided, verify it belongs to this same document
      // (don't let a malformed payload move a step into another doc's section).
      if (body.sectionId) {
        const sec = await db.query.procedureSections.findFirst({
          where: eq(schema.procedureSections.id, body.sectionId),
          columns: { documentId: true },
        });
        if (!sec || sec.documentId !== ctx.doc.id) {
          return reply.badRequest('sectionId does not belong to this document.');
        }
      }

      // If a linkedProcedureDocId is provided, verify it's a sibling
      // structured_procedure in the same content pack version. Cross-pack /
      // cross-version links would break when a pack is published or
      // versions roll over — we forbid them at the API layer rather than
      // letting the PWA hit a 404 mid-procedure.
      if (body.linkedProcedureDocId) {
        if (body.linkedProcedureDocId === ctx.doc.id) {
          return reply.badRequest(
            'A step cannot link to its own parent procedure.',
          );
        }
        const linked = await db.query.documents.findFirst({
          where: eq(schema.documents.id, body.linkedProcedureDocId),
          columns: {
            id: true,
            kind: true,
            contentPackVersionId: true,
          },
        });
        if (!linked) {
          return reply.badRequest('linkedProcedureDocId not found.');
        }
        if (linked.kind !== 'structured_procedure') {
          return reply.badRequest(
            'Only structured_procedure documents can be linked as sub-procedures.',
          );
        }
        if (linked.contentPackVersionId !== ctx.doc.contentPackVersionId) {
          return reply.badRequest(
            'Linked sub-procedure must live in the same content pack version.',
          );
        }
        // If a step subset was provided, verify every ID belongs to the
        // linked doc. Without this guard, the PWA would silently ignore
        // orphan IDs at render time and the author would have no idea
        // their subset is partially broken.
        if (body.linkedProcedureStepIds && body.linkedProcedureStepIds.length > 0) {
          const valid = await db.query.procedureSteps.findMany({
            where: and(
              eq(schema.procedureSteps.documentId, linked.id),
              inArray(schema.procedureSteps.id, body.linkedProcedureStepIds),
            ),
            columns: { id: true },
          });
          if (valid.length !== body.linkedProcedureStepIds.length) {
            return reply.badRequest(
              'linkedProcedureStepIds includes IDs that do not belong to the linked sub-procedure.',
            );
          }
        }
      } else if (
        body.linkedProcedureStepIds &&
        body.linkedProcedureStepIds.length > 0
      ) {
        // Subset without a parent link is meaningless — reject it so the
        // author notices the missing link rather than wondering why their
        // selection has no effect.
        return reply.badRequest(
          'linkedProcedureStepIds requires linkedProcedureDocId to be set.',
        );
      }

      // Default orderingHint: append at the end with a 100-stride gap so
      // future drag-reorders don't have to rewrite every row. Compute the
      // max within the target section (sectionId scope) so each section
      // numbers from 100 on the first step.
      let orderingHint = body.orderingHint;
      if (orderingHint === undefined) {
        const existing = await db.query.procedureSteps.findMany({
          where: body.sectionId
            ? and(
                eq(schema.procedureSteps.documentId, ctx.doc.id),
                eq(schema.procedureSteps.sectionId, body.sectionId),
              )
            : eq(schema.procedureSteps.documentId, ctx.doc.id),
          columns: { orderingHint: true },
        });
        const max = existing.reduce(
          (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
          0,
        );
        orderingHint = max + 100;
      }

      // Snippet attach on create: verify the snippet exists and the caller
      // can read it (platform snippets visible to all; org snippets must
      // be in scope). Reject early with a clear 400 — silently dropping a
      // bad snippetId would leave the step looking detached on first read.
      if (body.snippetId) {
        const snippet = await db.query.procedureSnippets.findFirst({
          where: eq(schema.procedureSnippets.id, body.snippetId),
        });
        if (!snippet) {
          return reply.badRequest('snippetId not found.');
        }
        if (!snippet.isPlatform) {
          if (!snippet.ownerOrganizationId) {
            return reply.internalServerError('snippet has no owner');
          }
          requireOrgInScope(scope, snippet.ownerOrganizationId);
        }
      }

      const [row] = await db
        .insert(schema.procedureSteps)
        .values({
          documentId: ctx.doc.id,
          sectionId: body.sectionId ?? null,
          linkedProcedureDocId: body.linkedProcedureDocId ?? null,
          linkedProcedureStepIds: body.linkedProcedureStepIds ?? [],
          kind: body.kind,
          title: body.title,
          bodyMarkdown: body.bodyMarkdown ?? null,
          safetyCritical: body.safetyCritical ?? body.kind === 'safety_check',
          orderingHint,
          requiresPhoto: evidence.requiresPhoto,
          minPhotoCount: evidence.minPhotoCount,
          measurementSpec: evidence.measurementSpec ?? null,
          blocks: body.blocks ?? [],
          snippetId: body.snippetId ?? null,
          snippetDetached: false,
          createdByUserId: auth.userId,
          // Newly-created step is searchable as soon as the sweeper picks
          // it up. Indexer is idempotent — it'll dedup on (version, type, id).
          searchIndexStaleAt: new Date(),
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create step.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.created',
        targetType: 'procedure_step',
        targetId: row.id,
        payload: {
          documentId: row.documentId,
          kind: row.kind,
          title: row.title,
          safetyCritical: row.safetyCritical,
          snippetId: row.snippetId,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const [dto] = await rowsToExpandedDTO(db, [row], {
        audioPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mediaPublicUrl: (k) => app.ctx.storage.publicUrl(k),
      });
      return dto;
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-steps/:stepId
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { stepId: string };
    Body: z.infer<typeof StepPatchBody>;
  }>(
    '/admin/procedure-steps/:stepId',
    {
      schema: {
        params: z.object({ stepId: UuidSchema }),
        body: StepPatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();
      const b = request.body;

      // Compute the post-patch evidence shape so we can validate kind
      // coherence before hitting the DB CHECK.
      const nextKind = b.kind ?? ctx.step.kind;
      const evidence = coerceEvidence({
        kind: nextKind,
        requiresPhoto:
          b.requiresPhoto !== undefined ? b.requiresPhoto : ctx.step.requiresPhoto,
        minPhotoCount:
          b.minPhotoCount !== undefined ? b.minPhotoCount : ctx.step.minPhotoCount,
        measurementSpec:
          b.measurementSpec !== undefined ? b.measurementSpec : ctx.step.measurementSpec,
      });

      // sectionId patch: validate the target section belongs to the same doc.
      // null = move to orphan (renders above the first section).
      if (b.sectionId !== undefined && b.sectionId !== null) {
        const sec = await db.query.procedureSections.findFirst({
          where: eq(schema.procedureSections.id, b.sectionId),
          columns: { documentId: true },
        });
        if (!sec || sec.documentId !== ctx.step.documentId) {
          return reply.badRequest('sectionId does not belong to this document.');
        }
      }

      // linkedProcedureDocId patch: same rules as create — sibling
      // structured_procedure in the same content pack version, no self-
      // reference. Null clears the link.
      // Also validate any subset patch against the (incoming or current)
      // linked doc.
      const nextLinkedDocId =
        b.linkedProcedureDocId !== undefined
          ? b.linkedProcedureDocId
          : ctx.step.linkedProcedureDocId;
      if (b.linkedProcedureDocId !== undefined && b.linkedProcedureDocId !== null) {
        if (b.linkedProcedureDocId === ctx.step.documentId) {
          return reply.badRequest(
            'A step cannot link to its own parent procedure.',
          );
        }
        const linked = await db.query.documents.findFirst({
          where: eq(schema.documents.id, b.linkedProcedureDocId),
          columns: {
            id: true,
            kind: true,
            contentPackVersionId: true,
          },
        });
        if (!linked) {
          return reply.badRequest('linkedProcedureDocId not found.');
        }
        if (linked.kind !== 'structured_procedure') {
          return reply.badRequest(
            'Only structured_procedure documents can be linked as sub-procedures.',
          );
        }
        // Use the step's own doc → its packVersion for the same-version
        // check. ctx.step has only the step's documentId; resolve the
        // parent doc's pack version once.
        const parent = await db.query.documents.findFirst({
          where: eq(schema.documents.id, ctx.step.documentId),
          columns: { contentPackVersionId: true },
        });
        if (
          !parent ||
          linked.contentPackVersionId !== parent.contentPackVersionId
        ) {
          return reply.badRequest(
            'Linked sub-procedure must live in the same content pack version.',
          );
        }
      }
      // Subset validation. Two cases:
      //   1. Patching subset alone → use the EXISTING linkedProcedureDocId.
      //      If there's no current link, reject (orphan subset).
      //   2. Patching link + subset together → validate against the new link.
      if (
        b.linkedProcedureStepIds !== undefined &&
        b.linkedProcedureStepIds.length > 0
      ) {
        if (!nextLinkedDocId) {
          return reply.badRequest(
            'linkedProcedureStepIds requires linkedProcedureDocId to be set.',
          );
        }
        const valid = await db.query.procedureSteps.findMany({
          where: and(
            eq(schema.procedureSteps.documentId, nextLinkedDocId),
            inArray(schema.procedureSteps.id, b.linkedProcedureStepIds),
          ),
          columns: { id: true },
        });
        if (valid.length !== b.linkedProcedureStepIds.length) {
          return reply.badRequest(
            'linkedProcedureStepIds includes IDs that do not belong to the linked sub-procedure.',
          );
        }
      }
      // Clearing the parent link also clears any stale subset so a future
      // re-link starts fresh.
      if (b.linkedProcedureDocId === null) {
        b.linkedProcedureStepIds = [];
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.kind !== undefined) patch.kind = nextKind;
      if (b.title !== undefined) patch.title = b.title;
      if (b.bodyMarkdown !== undefined) patch.bodyMarkdown = b.bodyMarkdown;
      if (b.safetyCritical !== undefined) patch.safetyCritical = b.safetyCritical;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.sectionId !== undefined) patch.sectionId = b.sectionId;
      if (b.linkedProcedureDocId !== undefined) {
        patch.linkedProcedureDocId = b.linkedProcedureDocId;
      }
      if (b.linkedProcedureStepIds !== undefined) {
        patch.linkedProcedureStepIds = b.linkedProcedureStepIds;
      }
      if (b.blocks !== undefined) patch.blocks = b.blocks;
      // Always write the coerced evidence trio if any of them changed,
      // so coherence is preserved.
      if (
        b.requiresPhoto !== undefined ||
        b.minPhotoCount !== undefined ||
        b.measurementSpec !== undefined ||
        b.kind !== undefined
      ) {
        patch.requiresPhoto = evidence.requiresPhoto;
        patch.minPhotoCount = evidence.minPhotoCount;
        patch.measurementSpec = evidence.measurementSpec;
      }
      // Mark search-index dirty when any field that affects the indexed
      // text changes. Non-searchable changes (sectionId rebucketing,
      // ordering, linked sub-procedure picks) don't trigger a re-embed.
      if (
        b.title !== undefined ||
        b.blocks !== undefined ||
        b.kind !== undefined ||
        b.safetyCritical !== undefined ||
        b.sectionId !== undefined
      ) {
        patch.searchIndexStaleAt = new Date();
      }

      // Snippet detach-on-edit. If the step references a snippet and is
      // still attached (snippet_detached=false), and the caller modifies
      // either blocks or title, then we copy the snippet's current content
      // into the step's own columns (preserving the visible state) and
      // flip snippet_detached=true. From this point on the step drifts
      // independently.
      //
      // We do this BEFORE building the SQL UPDATE so the snippet's blocks
      // (when patch.blocks wasn't supplied) still land in the row at
      // detach time. Without this, detaching would leave the step with
      // its prior author-supplied blocks (often empty) and the snippet's
      // expanded blocks would not be visible after the next read.
      let detachedNow = false;
      if (
        ctx.step.snippetId &&
        !ctx.step.snippetDetached &&
        (b.blocks !== undefined || b.title !== undefined)
      ) {
        const snippet = await db.query.procedureSnippets.findFirst({
          where: eq(schema.procedureSnippets.id, ctx.step.snippetId),
        });
        if (snippet) {
          // Capture snippet content into the step row so the post-detach
          // view matches the pre-detach view, then layer the author's
          // patch on top.
          if (b.blocks === undefined) patch.blocks = snippet.blocks;
          if (b.title === undefined || b.title.length === 0) {
            patch.title = snippet.title;
          }
        }
        patch.snippetDetached = true;
        detachedNow = true;
      }

      const [updated] = await db
        .update(schema.procedureSteps)
        .set(patch)
        .where(eq(schema.procedureSteps.id, ctx.step.id))
        .returning();
      if (!updated) return reply.internalServerError('Update failed.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: detachedNow ? 'procedure_step.snippet_detached' : 'procedure_step.updated',
        targetType: 'procedure_step',
        targetId: updated.id,
        payload: {
          fields: Object.keys(b),
          ...(detachedNow ? { snippetId: ctx.step.snippetId } : {}),
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      const [dto] = await rowsToExpandedDTO(db, [updated], {
        audioPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mediaPublicUrl: (k) => app.ctx.storage.publicUrl(k),
      });
      return dto;
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/procedure-steps/:stepId
  //
  // Returns 409 if any procedure_step_completions reference this step —
  // we don't want to silently drop run evidence. The author should
  // first archive or rewrite the procedure (v2 surface).
  // -------------------------------------------------------------------------
  app.delete<{ Params: { stepId: string } }>(
    '/admin/procedure-steps/:stepId',
    { schema: { params: z.object({ stepId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();

      const completionCount = await db.query.procedureStepCompletions.findFirst({
        where: eq(schema.procedureStepCompletions.stepId, ctx.step.id),
        columns: { id: true },
      });
      if (completionCount) {
        return reply
          .code(409)
          .send({
            statusCode: 409,
            error: 'Conflict',
            message:
              'Step has historical run evidence and cannot be deleted. Edit it instead, or rebuild the procedure under a new version.',
          });
      }

      // Clean the search-index row before deleting the step. FK ON DELETE
      // CASCADE would reach search_index_items via content_pack_version, but
      // not the per-source-row dedup — explicit cleanup keeps the index
      // tight without waiting for a manual rebuild.
      await db
        .delete(schema.searchIndexItems)
        .where(
          and(
            eq(schema.searchIndexItems.sourceType, 'procedure_step'),
            eq(schema.searchIndexItems.sourceId, ctx.step.id),
          ),
        );

      await db
        .delete(schema.procedureSteps)
        .where(eq(schema.procedureSteps.id, ctx.step.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.deleted',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: {
          documentId: ctx.step.documentId,
          title: ctx.step.title,
          kind: ctx.step.kind,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/procedure-steps/:stepId/parts — list linked parts
  // -------------------------------------------------------------------------
  app.get<{ Params: { stepId: string } }>(
    '/admin/procedure-steps/:stepId/parts',
    { schema: { params: z.object({ stepId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();

      const links = await db.query.partProcedureSteps.findMany({
        where: eq(schema.partProcedureSteps.procedureStepId, ctx.step.id),
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
  // PUT /admin/procedure-steps/:stepId/parts — set-replace
  // -------------------------------------------------------------------------
  app.put<{
    Params: { stepId: string };
    Body: { partIds: string[] };
  }>(
    '/admin/procedure-steps/:stepId/parts',
    {
      schema: {
        params: z.object({ stepId: UuidSchema }),
        body: z.object({ partIds: z.array(UuidSchema) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();
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
      const existing = await db.query.partProcedureSteps.findMany({
        where: eq(schema.partProcedureSteps.procedureStepId, ctx.step.id),
      });
      const existingIds = new Set(existing.map((e) => e.partId));
      const toDelete = existing.filter((e) => !wanted.has(e.partId));
      const toInsert = [...wanted].filter((pid) => !existingIds.has(pid));
      removed = toDelete.length;
      added = toInsert.length;

      if (toDelete.length > 0) {
        await db
          .delete(schema.partProcedureSteps)
          .where(
            inArray(
              schema.partProcedureSteps.id,
              toDelete.map((d) => d.id),
            ),
          );
      }
      if (toInsert.length > 0) {
        await db.insert(schema.partProcedureSteps).values(
          toInsert.map((partId) => ({
            partId,
            procedureStepId: ctx.step.id,
            createdByUserId: auth.userId,
          })),
        );
      }

      if (added > 0 || removed > 0) {
        await db.insert(schema.auditEvents).values({
          organizationId: ctx.ownerOrganizationId,
          actorUserId: auth.userId,
          eventType: 'procedure_step.parts.set',
          targetType: 'procedure_step',
          targetId: ctx.step.id,
          payload: {
            documentId: ctx.step.documentId,
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
  // POST /admin/documents/:documentId/procedure-steps/reorder
  //
  // Single-shot rewrite of orderingHint values at intervals of 100. Lets
  // a single drag-reorder land in one round-trip.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: z.infer<typeof ReorderBody>;
  }>(
    '/admin/documents/:documentId/procedure-steps/reorder',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: ReorderBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      // Verify all IDs belong to this document. Reject if any are foreign;
      // a payload that mixes docs would silently move steps across docs.
      const steps = await db.query.procedureSteps.findMany({
        where: and(
          eq(schema.procedureSteps.documentId, ctx.doc.id),
          inArray(schema.procedureSteps.id, request.body.orderedIds),
        ),
        columns: { id: true },
      });
      if (steps.length !== request.body.orderedIds.length) {
        return reply.badRequest(
          'orderedIds contains IDs not on this document, or duplicates.',
        );
      }

      // Re-stamp ordering hints. 100-stride leaves headroom for future
      // single-step inserts without a full rewrite.
      let i = 0;
      for (const id of request.body.orderedIds) {
        i += 1;
        await db
          .update(schema.procedureSteps)
          .set({ orderingHint: i * 100, updatedAt: new Date() })
          .where(eq(schema.procedureSteps.id, id));
      }

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step.reordered',
        targetType: 'document',
        targetId: ctx.doc.id,
        payload: { count: request.body.orderedIds.length },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true, count: request.body.orderedIds.length };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId/sibling-procedures
  //
  // Returns every other structured_procedure doc in the same content pack
  // version. Used by the StepCard's "Linked sub-procedure" picker so the
  // dropdown has a list to choose from without the admin client having to
  // fetch the whole pack tree.
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/sibling-procedures',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();
      const siblings = await db.query.documents.findMany({
        where: and(
          eq(
            schema.documents.contentPackVersionId,
            ctx.doc.contentPackVersionId,
          ),
          eq(schema.documents.kind, 'structured_procedure'),
        ),
        columns: { id: true, title: true },
        orderBy: [asc(schema.documents.title)],
      });
      return siblings.filter((s) => s.id !== ctx.doc.id);
    },
  );

  // ===========================================================================
  // procedure_sections — author-time grouping above procedure_steps.
  // ===========================================================================

  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId/procedure-sections
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/procedure-sections',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const rows = await db.query.procedureSections.findMany({
        where: eq(schema.procedureSections.documentId, request.params.documentId),
        orderBy: [
          asc(schema.procedureSections.orderingHint),
          asc(schema.procedureSections.createdAt),
        ],
      });
      return rows.map(sectionRowToDTO);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/procedure-sections — create
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: { title: string; description?: string | null; orderingHint?: number };
  }>(
    '/admin/documents/:documentId/procedure-sections',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200),
          description: z.string().max(2000).nullable().optional(),
          orderingHint: z.number().int().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();
      if (ctx.doc.kind !== 'structured_procedure') {
        return reply.badRequest(
          'Sections can only be authored on structured_procedure documents.',
        );
      }

      let orderingHint = request.body.orderingHint;
      if (orderingHint === undefined) {
        const existing = await db.query.procedureSections.findMany({
          where: eq(schema.procedureSections.documentId, ctx.doc.id),
          columns: { orderingHint: true },
        });
        const max = existing.reduce(
          (acc, r) => (r.orderingHint > acc ? r.orderingHint : acc),
          0,
        );
        orderingHint = max + 100;
      }

      const [row] = await db
        .insert(schema.procedureSections)
        .values({
          documentId: ctx.doc.id,
          title: request.body.title,
          description: request.body.description ?? null,
          orderingHint,
          createdByUserId: auth.userId,
          searchIndexStaleAt: new Date(),
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create section.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_section.created',
        targetType: 'procedure_section',
        targetId: row.id,
        payload: { documentId: row.documentId, title: row.title },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return sectionRowToDTO(row);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-sections/:sectionId — rename / reorder
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { sectionId: string };
    Body: { title?: string; description?: string | null; orderingHint?: number };
  }>(
    '/admin/procedure-sections/:sectionId',
    {
      schema: {
        params: z.object({ sectionId: UuidSchema }),
        body: z
          .object({
            title: z.string().min(1).max(200).optional(),
            description: z.string().max(2000).nullable().optional(),
            orderingHint: z.number().int().optional(),
          })
          .refine((v) => Object.keys(v).length > 0, {
            message: 'At least one field is required.',
          }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const section = await db.query.procedureSections.findFirst({
        where: eq(schema.procedureSections.id, request.params.sectionId),
      });
      if (!section) return reply.notFound();
      const ctx = await loadDocumentForWrite(db, section.documentId, scope);
      if (!ctx) return reply.notFound();

      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = b.title;
      if (b.description !== undefined) patch.description = b.description;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      // A renamed section's title is part of every child step's indexed
      // text — mark the section stale so the sweeper re-embeds it. (The
      // child steps re-embed only when their own row changes; the slight
      // stale window for their `sectionTitle` field is acceptable.)
      if (b.title !== undefined || b.description !== undefined) {
        patch.searchIndexStaleAt = new Date();
      }

      const [updated] = await db
        .update(schema.procedureSections)
        .set(patch)
        .where(eq(schema.procedureSections.id, section.id))
        .returning();
      if (!updated) return reply.internalServerError('Update failed.');

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_section.updated',
        targetType: 'procedure_section',
        targetId: updated.id,
        payload: { fields: Object.keys(b) },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return sectionRowToDTO(updated);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/procedure-sections/:sectionId
  //
  // FK is set null, so deleting a section orphans (doesn't delete) its
  // steps. The PWA renders orphans above the first explicit section, which
  // is a safe fallback while the author reorganizes.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { sectionId: string } }>(
    '/admin/procedure-sections/:sectionId',
    { schema: { params: z.object({ sectionId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const section = await db.query.procedureSections.findFirst({
        where: eq(schema.procedureSections.id, request.params.sectionId),
      });
      if (!section) return reply.notFound();
      const ctx = await loadDocumentForWrite(db, section.documentId, scope);
      if (!ctx) return reply.notFound();

      await db
        .delete(schema.procedureSections)
        .where(eq(schema.procedureSections.id, section.id));

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_section.deleted',
        targetType: 'procedure_section',
        targetId: section.id,
        payload: { documentId: section.documentId, title: section.title },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/procedure-sections/reorder
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: { orderedIds: string[] };
  }>(
    '/admin/documents/:documentId/procedure-sections/reorder',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: z.object({ orderedIds: z.array(UuidSchema).min(1) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const sections = await db.query.procedureSections.findMany({
        where: and(
          eq(schema.procedureSections.documentId, ctx.doc.id),
          inArray(schema.procedureSections.id, request.body.orderedIds),
        ),
        columns: { id: true },
      });
      if (sections.length !== request.body.orderedIds.length) {
        return reply.badRequest(
          'orderedIds contains IDs not on this document, or duplicates.',
        );
      }

      let i = 0;
      for (const id of request.body.orderedIds) {
        i += 1;
        await db
          .update(schema.procedureSections)
          .set({ orderingHint: i * 100, updatedAt: new Date() })
          .where(eq(schema.procedureSections.id, id));
      }

      await db.insert(schema.auditEvents).values({
        organizationId: ctx.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_section.reordered',
        targetType: 'document',
        targetId: ctx.doc.id,
        payload: { count: request.body.orderedIds.length },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true, count: request.body.orderedIds.length };
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/documents/:documentId/procedure-outline
  //
  // Combined sections + steps in one round-trip so the editor can render
  // the full outline (sections grouping steps) without a per-section fetch.
  // -------------------------------------------------------------------------
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/procedure-outline',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request, reply) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadDocumentForWrite(db, request.params.documentId, scope);
      if (!ctx) return reply.notFound();

      const [sections, steps] = await Promise.all([
        db.query.procedureSections.findMany({
          where: eq(schema.procedureSections.documentId, ctx.doc.id),
          orderBy: [
            asc(schema.procedureSections.orderingHint),
            asc(schema.procedureSections.createdAt),
          ],
        }),
        db.query.procedureSteps.findMany({
          where: eq(schema.procedureSteps.documentId, ctx.doc.id),
          orderBy: [
            asc(schema.procedureSteps.orderingHint),
            asc(schema.procedureSteps.createdAt),
          ],
        }),
      ]);

      return {
        sections: sections.map(sectionRowToDTO),
        steps: await rowsToExpandedDTO(db, steps, {
          audioPublicUrl: (k) => storage.publicUrl(k),
          mediaPublicUrl: (k) => storage.publicUrl(k),
        }),
      };
    },
  );
}

function sectionRowToDTO(row: typeof schema.procedureSections.$inferSelect) {
  return {
    id: row.id,
    documentId: row.documentId,
    title: row.title,
    description: row.description,
    orderingHint: row.orderingHint,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
