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
import { recordAudit } from '../lib/audit.js';
import {
  expandStep,
  loadSnippetMap,
  type SnippetBadge,
} from '../services/snippet-expansion.js';
import { muxClipUrlFor, type MuxClient } from '../lib/mux.js';
import {
  procedureStepCategoryToDTO,
  type ProcedureStepCategoryDTO,
} from './admin-procedure-step-categories.js';

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
  // Permissive on write — the slash-menu inserts blocks empty and the
  // debounced auto-save would otherwise 400 on a freshly-added block
  // before the author types into it. Empty text renders as nothing in
  // the runner, which matches the paragraph block behavior.
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
  // Permissive on write (no min length) for the same reason CalloutBlock
  // allows empty text: the slash-menu inserts a Photo block with an empty
  // storageKey and the debounced auto-save fires before the author picks an
  // image. A min(1) here rejected the WHOLE blocks array, so every save
  // 400'd until a photo was chosen or the block deleted. An empty storageKey
  // matches no media at read time, so the runner renders nothing (see the
  // photo_inline case in virtual-job-aid.tsx) — same as an empty callout.
  storageKey: z.string().max(400),
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
    // Optional semantic category. Server validates that the category is
    // visible to the caller's scope (built-in or in-scope per-org). Null
    // = no category badge on this individual step (the runner falls back
    // to the section's own category for coloring).
    categoryId: UuidSchema.nullable().optional(),
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
    // Move a step's category (or clear with null).
    categoryId: UuidSchema.nullable().optional(),
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
    /** Mux client — used to build per-step instant-clip URLs for
     *  video_clip media entries (handles signed-token minting when
     *  the deployment uses signed playback). Optional; when omitted,
     *  video_clip entries fall back to the unbounded source URL,
     *  which is safe for callers that don't render playback (e.g.,
     *  introspection / debug endpoints). */
    mux?: MuxClient;
    /** Override for blocks/title after snippet expansion. When set, these
     *  replace the row's own blocks/title in the returned DTO. */
    expanded?: { blocks: StepRow['blocks']; title: string };
    /** Snippet provenance badge — set when the step references a snippet. */
    snippetBadge?: SnippetBadge | null;
    /** Resolved category DTO — set when the step references a category
     *  visible to the caller. Null otherwise (no badge). */
    category?: ProcedureStepCategoryDTO | null;
  },
) {
  // Expand each media item with a publicly-resolvable URL so the admin
  // editor and PWA runner can render thumbnails without a second round-
  // trip per item. For drafter-produced video_clip entries, also derive
  // the Mux instant-clip HLS endpoint (per-step `?asset_start_time=…
  // &asset_end_time=…` URL or signed-JWT equivalent) so the player can
  // stream just the step's clip range natively.
  const media = (row.media ?? []).map((m) => {
    const base = {
      ...m,
      url: opts?.mediaPublicUrl ? opts.mediaPublicUrl(m.storageKey) : null,
    };
    if (m.kind === 'video_clip') {
      const streamUrl = opts?.mux
        ? muxClipUrlFor(opts.mux, {
            playbackId: m.clip.playbackId,
            startMs: m.clip.startMs,
            endMs: m.clip.endMs,
          })
        : `https://stream.mux.com/${m.clip.playbackId}.m3u8`;
      return {
        ...base,
        clip: {
          ...m.clip,
          streamUrl,
        },
      };
    }
    return base;
  });
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
    categoryId: row.categoryId,
    category: opts?.category ?? null,
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
    /** Mux client — used to build per-step instant-clip URLs for
     *  video_clip media entries. Optional because the platform supports
     *  Mux-less deployments; video_clip media can only have been
     *  authored on a Mux-enabled deployment, so this is effectively
     *  required in practice but typed as optional for parity with
     *  `app.ctx.mux`. */
    mux?: MuxClient;
  },
): Promise<ReturnType<typeof rowToDTO>[]> {
  const snippetMap = await loadSnippetMap(
    db,
    rows.map((r) => r.snippetId),
  );
  // Resolve every distinct category referenced by these rows in one shot
  // so the editor sees the full DTO (color/icon/name) on each step card
  // without an N+1 fetch.
  const categoryIds = [
    ...new Set(
      rows.map((r) => r.categoryId).filter((id): id is string => id !== null),
    ),
  ];
  const categoriesById = new Map<string, ProcedureStepCategoryDTO>();
  if (categoryIds.length > 0) {
    const catRows = await db.query.procedureStepCategories.findMany({
      where: inArray(schema.procedureStepCategories.id, categoryIds),
    });
    for (const c of catRows) categoriesById.set(c.id, procedureStepCategoryToDTO(c));
  }
  return rows.map((r) => {
    const expanded = expandStep(
      {
        snippetId: r.snippetId,
        snippetDetached: r.snippetDetached,
        title: r.title,
        blocks: r.blocks ?? [],
        audioStorageKey: r.audioStorageKey,
      },
      snippetMap,
    );
    // Audio URL hierarchy: step's own audio wins; otherwise the snippet's
    // inherited audio plays at runtime (and surfaces here for the admin
    // editor's preview).
    const effectiveAudioKey = r.audioStorageKey ?? expanded.inheritedAudioStorageKey;
    return rowToDTO(r, {
      audioPublicUrl: effectiveAudioKey ? ctx.audioPublicUrl(effectiveAudioKey) : null,
      mediaPublicUrl: ctx.mediaPublicUrl,
      mux: ctx.mux,
      expanded: { blocks: expanded.blocks, title: expanded.title },
      snippetBadge: expanded._snippetBadge,
      category: r.categoryId ? categoriesById.get(r.categoryId) ?? null : null,
    });
  });
}

/**
 * Validate that a category id (when supplied) is visible to the caller:
 * it must be a built-in (organization_id IS NULL) or owned by an org the
 * caller has scope for. Returns the resolved row on success (callers can
 * use it for audit-event payloads); throws via the supplied reply helper
 * on failure.
 */
async function loadCategoryForUse(
  db: Database,
  categoryId: string,
  scope: { all: boolean; orgIds: string[] },
): Promise<typeof schema.procedureStepCategories.$inferSelect | null> {
  const row = await db.query.procedureStepCategories.findFirst({
    where: eq(schema.procedureStepCategories.id, categoryId),
  });
  if (!row) return null;
  if (row.organizationId === null) return row; // built-in, visible to all
  if (scope.all) return row;
  if (!scope.orgIds.includes(row.organizationId)) return null;
  return row;
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
        mux: app.ctx.mux,
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

      // Category attach on create: verify the category is visible to the
      // caller's scope. Built-ins (org_id IS NULL) are always visible;
      // org-specific categories must belong to an org in scope.
      if (body.categoryId) {
        const cat = await loadCategoryForUse(db, body.categoryId, scope);
        if (!cat) {
          return reply.badRequest(
            'categoryId is not visible to this caller (unknown or out of scope).',
          );
        }
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
          categoryId: body.categoryId ?? null,
          createdByUserId: auth.userId,
          // Newly-created step is searchable as soon as the sweeper picks
          // it up. Indexer is idempotent — it'll dedup on (version, type, id).
          searchIndexStaleAt: new Date(),
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create step.');

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
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
      });

      const [dto] = await rowsToExpandedDTO(db, [row], {
        audioPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mediaPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mux: app.ctx.mux,
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

      // categoryId patch: validate visibility (built-in or in-scope org).
      // Null clears the category — the runner falls back to the section's
      // own category for visual treatment on that step.
      if (b.categoryId !== undefined && b.categoryId !== null) {
        const cat = await loadCategoryForUse(db, b.categoryId, scope);
        if (!cat) {
          return reply.badRequest(
            'categoryId is not visible to this caller (unknown or out of scope).',
          );
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
      if (b.categoryId !== undefined) patch.categoryId = b.categoryId;
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
          // Also copy the snippet's audio if the step had none of its own
          // — keeps the post-detach playback identical to what the tech
          // was hearing pre-detach. Step-own audio (the rare case where
          // a step had an override) stays untouched.
          if (!ctx.step.audioStorageKey && snippet.audioStorageKey) {
            patch.audioStorageKey = snippet.audioStorageKey;
            patch.audioContentType = snippet.audioContentType;
            patch.audioSizeBytes = snippet.audioSizeBytes;
            patch.audioDurationMs = snippet.audioDurationMs;
            patch.audioSource = snippet.audioSource;
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

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: detachedNow ? 'procedure_step.snippet_detached' : 'procedure_step.updated',
        targetType: 'procedure_step',
        targetId: updated.id,
        payload: {
          fields: Object.keys(b),
          ...(detachedNow ? { snippetId: ctx.step.snippetId } : {}),
        },
      });

      const [dto] = await rowsToExpandedDTO(db, [updated], {
        audioPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mediaPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mux: app.ctx.mux,
      });
      return dto;
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-steps/:stepId/clip-range
  //
  // Update the [startMs..endMs] window on the step's first video_clip
  // media entry. Lets admins tighten AI-walkthrough cuts after publish
  // without rebuilding the procedure.
  //
  // Floor is intentionally lower than the drafter's STEP_CLIP_MIN_MS
  // (2s). The drafter's floor is a target for LLM emissions — once an
  // author is hand-trimming, a brief glance of motion (e.g., 300ms of
  // "click here") is sometimes exactly what they want. 200ms is the
  // absolute minimum that still renders a discernible frame across
  // common 30fps source captures. Steps without a video_clip media
  // entry get a 400; the editor doesn't surface the panel in that case.
  // -------------------------------------------------------------------------
  const CLIP_MIN_MS = 200;
  const CLIP_MAX_MS = 20_000;
  app.patch<{
    Params: { stepId: string };
    Body: { startMs: number; endMs: number };
  }>(
    '/admin/procedure-steps/:stepId/clip-range',
    {
      schema: {
        params: z.object({ stepId: UuidSchema }),
        body: z.object({
          // 24h max bound — covers any plausible source video while
          // bounding the validator surface.
          startMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
          endMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const ctx = await loadStepForWrite(db, request.params.stepId, scope);
      if (!ctx) return reply.notFound();
      const { startMs, endMs } = request.body;
      if (endMs <= startMs) {
        return reply.badRequest('endMs must be greater than startMs');
      }
      const span = endMs - startMs;
      if (span < CLIP_MIN_MS) {
        return reply.badRequest(
          `clip duration ${span}ms is below the minimum ${CLIP_MIN_MS}ms`,
        );
      }
      if (span > CLIP_MAX_MS) {
        return reply.badRequest(
          `clip duration ${span}ms exceeds the maximum ${CLIP_MAX_MS}ms`,
        );
      }

      // Update the FIRST video_clip media entry in place. A step can in
      // principle carry several media items; v1 of the drafter writes
      // exactly one video_clip per step. If a future feature attaches
      // more, this endpoint targets the first — clear-enough mental model
      // and avoids a media-id field on the request (which would complicate
      // the editor for the 99% case).
      const media = ctx.step.media ?? [];
      const clipIdx = media.findIndex((m) => m.kind === 'video_clip');
      if (clipIdx === -1) {
        return reply.badRequest(
          'This step has no video clip to trim. Add one before editing the clip range.',
        );
      }
      const target = media[clipIdx]!;
      if (target.kind !== 'video_clip') {
        // findIndex above guarantees this; the narrowing is for TS.
        return reply.internalServerError('clip media kind mismatch');
      }
      const prev = { startMs: target.clip.startMs, endMs: target.clip.endMs };
      const nextMedia = media.map((m, i) =>
        i === clipIdx && m.kind === 'video_clip'
          ? {
              ...m,
              clip: {
                ...m.clip,
                startMs,
                endMs,
              },
            }
          : m,
      );

      const [updated] = await db
        .update(schema.procedureSteps)
        .set({ media: nextMedia, updatedAt: new Date() })
        .where(eq(schema.procedureSteps.id, ctx.step.id))
        .returning();
      if (!updated) return reply.internalServerError('Update failed.');

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.clip_range_edited',
        targetType: 'procedure_step',
        targetId: updated.id,
        payload: {
          from: prev,
          to: { startMs, endMs },
          playbackId: target.clip.playbackId,
        },
      });

      const [dto] = await rowsToExpandedDTO(db, [updated], {
        audioPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mediaPublicUrl: (k) => app.ctx.storage.publicUrl(k),
        mux: app.ctx.mux,
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

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.deleted',
        targetType: 'procedure_step',
        targetId: ctx.step.id,
        payload: {
          documentId: ctx.step.documentId,
          title: ctx.step.title,
          kind: ctx.step.kind,
        },
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
        await recordAudit(db, request, {
          organizationId: ctx.ownerOrganizationId,
          eventType: 'procedure_step.parts.set',
          targetType: 'procedure_step',
          targetId: ctx.step.id,
          payload: {
            documentId: ctx.step.documentId,
            partCount: wanted.size,
            added,
            removed,
          },
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

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_step.reordered',
        targetType: 'document',
        targetId: ctx.doc.id,
        payload: { count: request.body.orderedIds.length },
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
      const categoriesById = await loadSectionCategoryMap(db, rows);
      return rows.map((r) =>
        sectionRowToDTO(
          r,
          r.categoryId ? categoriesById.get(r.categoryId) ?? null : null,
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/documents/:documentId/procedure-sections — create
  // -------------------------------------------------------------------------
  app.post<{
    Params: { documentId: string };
    Body: {
      title: string;
      description?: string | null;
      orderingHint?: number;
      categoryId?: string | null;
    };
  }>(
    '/admin/documents/:documentId/procedure-sections',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200),
          description: z.string().max(2000).nullable().optional(),
          orderingHint: z.number().int().optional(),
          // Optional semantic category — drives the PWA phase-progress
          // strip's color/icon for this section. Validated against the
          // caller's scope (built-in or in-scope per-org).
          categoryId: UuidSchema.nullable().optional(),
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

      if (request.body.categoryId) {
        const cat = await loadCategoryForUse(db, request.body.categoryId, scope);
        if (!cat) {
          return reply.badRequest(
            'categoryId is not visible to this caller (unknown or out of scope).',
          );
        }
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
          categoryId: request.body.categoryId ?? null,
          createdByUserId: auth.userId,
          searchIndexStaleAt: new Date(),
        })
        .returning();
      if (!row) return reply.internalServerError('Failed to create section.');

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_section.created',
        targetType: 'procedure_section',
        targetId: row.id,
        payload: { documentId: row.documentId, title: row.title },
      });

      const categoriesById = await loadSectionCategoryMap(db, [row]);
      return sectionRowToDTO(
        row,
        row.categoryId ? categoriesById.get(row.categoryId) ?? null : null,
      );
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-sections/:sectionId — rename / reorder / recategorize
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { sectionId: string };
    Body: {
      title?: string;
      description?: string | null;
      orderingHint?: number;
      categoryId?: string | null;
    };
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
            // Recategorize the section, or clear with null (falls back
            // to neutral coloring on the PWA strip).
            categoryId: UuidSchema.nullable().optional(),
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

      if (b.categoryId !== undefined && b.categoryId !== null) {
        const cat = await loadCategoryForUse(db, b.categoryId, scope);
        if (!cat) {
          return reply.badRequest(
            'categoryId is not visible to this caller (unknown or out of scope).',
          );
        }
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.title !== undefined) patch.title = b.title;
      if (b.description !== undefined) patch.description = b.description;
      if (b.orderingHint !== undefined) patch.orderingHint = b.orderingHint;
      if (b.categoryId !== undefined) patch.categoryId = b.categoryId;
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

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_section.updated',
        targetType: 'procedure_section',
        targetId: updated.id,
        payload: { fields: Object.keys(b) },
      });

      const categoriesById = await loadSectionCategoryMap(db, [updated]);
      return sectionRowToDTO(
        updated,
        updated.categoryId ? categoriesById.get(updated.categoryId) ?? null : null,
      );
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

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_section.deleted',
        targetType: 'procedure_section',
        targetId: section.id,
        payload: { documentId: section.documentId, title: section.title },
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

      await recordAudit(db, request, {
        organizationId: ctx.ownerOrganizationId,
        eventType: 'procedure_section.reordered',
        targetType: 'document',
        targetId: ctx.doc.id,
        payload: { count: request.body.orderedIds.length },
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

      const sectionCategoriesById = await loadSectionCategoryMap(db, sections);
      return {
        sections: sections.map((sec) =>
          sectionRowToDTO(
            sec,
            sec.categoryId
              ? sectionCategoriesById.get(sec.categoryId) ?? null
              : null,
          ),
        ),
        steps: await rowsToExpandedDTO(db, steps, {
          audioPublicUrl: (k) => storage.publicUrl(k),
          mediaPublicUrl: (k) => storage.publicUrl(k),
          mux: app.ctx.mux,
        }),
      };
    },
  );
}

function sectionRowToDTO(
  row: typeof schema.procedureSections.$inferSelect,
  category?: ProcedureStepCategoryDTO | null,
) {
  return {
    id: row.id,
    documentId: row.documentId,
    title: row.title,
    description: row.description,
    orderingHint: row.orderingHint,
    categoryId: row.categoryId,
    category: category ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolve every category referenced by a list of section rows in one
 * round-trip and return a Map keyed by id. Empty when no sections are
 * categorized — common on legacy procedures.
 */
async function loadSectionCategoryMap(
  db: Database,
  sections: ReadonlyArray<typeof schema.procedureSections.$inferSelect>,
): Promise<Map<string, ProcedureStepCategoryDTO>> {
  const ids = [
    ...new Set(
      sections.map((s) => s.categoryId).filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db.query.procedureStepCategories.findMany({
    where: inArray(schema.procedureStepCategories.id, ids),
  });
  return new Map(rows.map((r) => [r.id, procedureStepCategoryToDTO(r)]));
}
