// Admin API for procedure_step_categories — author-extensible semantic
// tags that drive the PWA phase-progress strip's section colors and
// per-step badges.
//
// Surface (per-org scoped):
//   GET    /admin/organizations/:orgId/procedure-step-categories
//          → built-ins + that org's own custom categories
//   POST   /admin/organizations/:orgId/procedure-step-categories
//          → create a new custom category for that org
//   PATCH  /admin/procedure-step-categories/:id
//          → rename / recolor / re-icon. Built-ins are read-only for
//            non-platform-admins (the migration owns them).
//   DELETE /admin/procedure-step-categories/:id
//          → org-only. Built-ins return 409. Sections/steps referencing
//            the deleted row have their category_id set to NULL via FK.
//
// Visibility rule (mirrored in every read endpoint):
//   A category is visible to a caller when
//     organization_id IS NULL                                 -- built-in
//   OR organization_id matches an org in the caller's scope.  -- per-org
//
// Mutation rule:
//   * Built-ins (is_built_in = true OR organization_id IS NULL) are
//     mutable only by platform admins. Org admins get 403.
//   * Custom categories are mutable when the caller is in scope for the
//     owning organization.
//
// CHECK constraint enforced in Zod, not the DB:
//   color must match /^#[0-9a-fA-F]{6}$/
//   icon, when set, must be in the curated allowlist below

import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { schema } from '@platform/db';
import { z } from 'zod';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth.js';
import { getScope, requireOrgInScope } from '../middleware/scope.js';

// Curated icon allowlist. Lucide ships hundreds of icons; we ship a
// small set that maps to authoring contexts a tech would recognize on
// the phase strip. Adding to this list is cheap (one entry here + the
// admin picker imports the icon component). Removing is breaking — the
// PWA falls back to no icon, which is safe.
const ICON_ALLOWLIST = [
  'shield-alert', // safety
  'shield-check', // verified-safe
  'circle-check', // verification
  'clipboard-check',
  'wrench', // prep
  'cog',
  'hammer',
  'lock', // lockout
  'flame', // hazard
  'zap', // electrical
  'droplet', // hydraulics / leak check
  'ruler', // measurement
  'camera', // photo step
  'eye', // inspection
  'thermometer',
  'gauge',
  'package', // parts staging
  'sparkles', // cleanup
] as const;

type IconName = (typeof ICON_ALLOWLIST)[number];

const ColorHex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex like "#EAB308"');

const IconEnum = z.enum(ICON_ALLOWLIST);

const CreateBody = z.object({
  name: z.string().min(1).max(60).trim(),
  color: ColorHex,
  icon: IconEnum.optional().nullable(),
  sortOrder: z.number().int().optional(),
});

const PatchBody = z
  .object({
    name: z.string().min(1).max(60).trim().optional(),
    color: ColorHex.optional(),
    icon: IconEnum.optional().nullable(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required.',
  });

type Row = typeof schema.procedureStepCategories.$inferSelect;

function rowToDTO(row: Row) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    color: row.color,
    icon: (row.icon as IconName | null) ?? null,
    sortOrder: row.sortOrder,
    isBuiltIn: row.isBuiltIn,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ProcedureStepCategoryDTO = ReturnType<typeof rowToDTO>;

export async function registerAdminProcedureStepCategories(
  app: FastifyInstance,
) {
  // -------------------------------------------------------------------------
  // GET /admin/organizations/:orgId/procedure-step-categories
  //
  // Returns built-ins (organization_id IS NULL) + the org's own custom
  // categories, ordered by built-ins first (sort_order ascending), then
  // org categories (sort_order ascending). Lets the admin picker render
  // a single unified list with built-ins at the top.
  // -------------------------------------------------------------------------
  app.get<{ Params: { orgId: string } }>(
    '/admin/organizations/:orgId/procedure-step-categories',
    { schema: { params: z.object({ orgId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.params.orgId);

      const rows = await db.query.procedureStepCategories.findMany({
        where: or(
          isNull(schema.procedureStepCategories.organizationId),
          eq(schema.procedureStepCategories.organizationId, request.params.orgId),
        ),
        orderBy: [
          // Built-ins first: ordering NULL before a UUID requires a CASE.
          // Pseudo-sort by isBuiltIn DESC, then sortOrder ASC, then name ASC.
          sql`is_built_in desc`,
          asc(schema.procedureStepCategories.sortOrder),
          asc(schema.procedureStepCategories.name),
        ],
      });
      return rows.map(rowToDTO);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/organizations/:orgId/procedure-step-categories
  //
  // Create a new custom category for the given org. Built-in seeding is
  // a migration concern — this endpoint always creates with
  // organization_id = :orgId, is_built_in = false. Case-folded name
  // collisions within the org return 409.
  // -------------------------------------------------------------------------
  app.post<{
    Params: { orgId: string };
    Body: z.infer<typeof CreateBody>;
  }>(
    '/admin/organizations/:orgId/procedure-step-categories',
    {
      schema: {
        params: z.object({ orgId: UuidSchema }),
        body: CreateBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.params.orgId);

      let sortOrder = request.body.sortOrder;
      if (sortOrder === undefined) {
        // Append at the end with a 100-step gap so future reorders don't
        // rewrite every row. Computed within the org only — built-ins
        // share a separate ordering space.
        const existing = await db.query.procedureStepCategories.findMany({
          where: eq(
            schema.procedureStepCategories.organizationId,
            request.params.orgId,
          ),
          columns: { sortOrder: true },
        });
        const max = existing.reduce(
          (acc, r) => (r.sortOrder > acc ? r.sortOrder : acc),
          // Start after the built-in range so org-defined categories
          // render below "Safety" / "Verification" by default.
          100,
        );
        sortOrder = max + 100;
      }

      try {
        const [row] = await db
          .insert(schema.procedureStepCategories)
          .values({
            organizationId: request.params.orgId,
            name: request.body.name,
            color: request.body.color,
            icon: request.body.icon ?? null,
            sortOrder,
            isBuiltIn: false,
            createdByUserId: auth.userId,
          })
          .returning();
        if (!row) return reply.internalServerError('Failed to create category.');

        await db.insert(schema.auditEvents).values({
          organizationId: request.params.orgId,
          actorUserId: auth.userId,
          eventType: 'procedure_step_category.created',
          targetType: 'procedure_step_category',
          targetId: row.id,
          payload: {
            name: row.name,
            color: row.color,
            icon: row.icon,
          },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        return rowToDTO(row);
      } catch (e) {
        // Unique violation on the per-org partial index.
        if (
          e instanceof Error &&
          /unique|duplicate/i.test(e.message)
        ) {
          return reply.conflict(
            'A category with this name already exists for this organization.',
          );
        }
        throw e;
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/procedure-step-categories/:id
  //
  // Built-ins are read-only to non-platform-admins (they're owned by the
  // migration). Org categories are editable when the caller is in scope
  // for the owning org.
  // -------------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: z.infer<typeof PatchBody>;
  }>(
    '/admin/procedure-step-categories/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: PatchBody,
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const row = await db.query.procedureStepCategories.findFirst({
        where: eq(schema.procedureStepCategories.id, request.params.id),
      });
      if (!row) return reply.notFound();

      if (row.organizationId === null || row.isBuiltIn) {
        if (!scope.all) {
          return reply.forbidden(
            'Built-in categories are read-only. Create a custom category instead.',
          );
        }
      } else {
        requireOrgInScope(scope, row.organizationId);
      }

      const b = request.body;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (b.name !== undefined) patch.name = b.name;
      if (b.color !== undefined) patch.color = b.color;
      if (b.icon !== undefined) patch.icon = b.icon ?? null;
      if (b.sortOrder !== undefined) patch.sortOrder = b.sortOrder;

      try {
        const [updated] = await db
          .update(schema.procedureStepCategories)
          .set(patch)
          .where(eq(schema.procedureStepCategories.id, row.id))
          .returning();
        if (!updated) return reply.internalServerError('Update failed.');

        await db.insert(schema.auditEvents).values({
          // Audit lands on the owning org for org rows; on a SANTECH-side
          // org for built-ins. We have no SANTECH-internal org row here,
          // so attribute built-in edits to the actor's home org so the
          // event isn't lost.
          organizationId:
            row.organizationId ??
            (auth as { organizationId?: string }).organizationId ??
            row.id,
          actorUserId: auth.userId,
          eventType: 'procedure_step_category.updated',
          targetType: 'procedure_step_category',
          targetId: updated.id,
          payload: { fields: Object.keys(b) },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        return rowToDTO(updated);
      } catch (e) {
        if (e instanceof Error && /unique|duplicate/i.test(e.message)) {
          return reply.conflict(
            'A category with this name already exists for this organization.',
          );
        }
        throw e;
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/procedure-step-categories/:id
  //
  // Org-only. Built-ins return 409 (they're owned by the migration).
  // FK ON DELETE SET NULL takes care of any sections/steps that still
  // reference the deleted category — they fall back to neutral coloring.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/admin/procedure-step-categories/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const row = await db.query.procedureStepCategories.findFirst({
        where: eq(schema.procedureStepCategories.id, request.params.id),
      });
      if (!row) return reply.notFound();

      if (row.organizationId === null || row.isBuiltIn) {
        return reply.conflict(
          'Built-in categories cannot be deleted. Hide them from your authoring by not picking them.',
        );
      }
      requireOrgInScope(scope, row.organizationId);

      await db
        .delete(schema.procedureStepCategories)
        .where(eq(schema.procedureStepCategories.id, row.id));

      await db.insert(schema.auditEvents).values({
        organizationId: row.organizationId,
        actorUserId: auth.userId,
        eventType: 'procedure_step_category.deleted',
        targetType: 'procedure_step_category',
        targetId: row.id,
        payload: { name: row.name },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { ok: true };
    },
  );
}

// Re-exported for use by other route files that resolve category DTOs
// alongside section/step rows (procedure bundle, admin outline, etc.)
export { rowToDTO as procedureStepCategoryToDTO, ICON_ALLOWLIST };
export type ProcedureStepCategoryIcon = IconName;
