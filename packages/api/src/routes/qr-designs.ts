import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';

// Saved QR design CRUD. Backs the /qr-codes/designer canvas in the admin
// app. A design is a fully-self-contained QrStyleSpec (modules, eyes,
// colors, frame, embedded logo data URI) stored as opaque JSON.
//
// Authorization model:
//   - List/read: any user whose org scope contains the design's
//     organization_id. Designs are shared assets within the company.
//   - Create: any authenticated user, in any org their scope can write to.
//     Owner is recorded as the requester.
//   - Update/delete: owner OR platform admin. This stops a colleague from
//     accidentally clobbering someone else's saved design while still
//     letting platform admins clean up.
//
// Spec validation: we accept any JSON object up to ~6 MB. The actual shape
// is enforced by the client renderer — server-side strictness would make
// the schema brittle as the designer evolves (e.g. when a new dot shape
// is added). The MAX_SPEC_BYTES cap prevents a runaway data: URI from
// blowing up Postgres or our request pipeline.

const NameSchema = z.string().min(1).max(160);

// 6 MB cap on the serialized spec. A typical design without a logo is
// <2 KB; with a 1 MB PNG logo embedded as base64 it bloats to ~1.4 MB.
// 6 MB buys headroom for two embedded images / a large vector logo while
// staying well under Postgres' row size limits (we never approach TOAST
// overflow at this scale).
const MAX_SPEC_BYTES = 6 * 1024 * 1024;

// Accept any JSON object — the spec is opaque to the server. We reject
// arrays, primitives, and null because they're definitely not a valid
// QrStyleSpec, regardless of the version it was authored against.
const SpecSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (s) => JSON.stringify(s).length <= MAX_SPEC_BYTES,
    `Design spec exceeds the ${Math.round(MAX_SPEC_BYTES / 1024 / 1024)} MB cap — try a smaller logo.`,
  );

export async function registerQrDesignRoutes(app: FastifyInstance) {
  // List designs visible to the caller. Returns newest-updated first so the
  // designer's sidebar surfaces recent work without a client-side sort.
  app.get('/admin/qr-designs', async (request) => {
    const { db } = app.ctx;
    const auth = requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) return [];

    const rows = await db.query.qrDesigns.findMany({
      where: scope.all
        ? undefined
        : (t, { inArray }) => inArray(t.organizationId, scope.orgIds),
      with: { organization: true, owner: true },
    });
    rows.sort((a, b) => +b.updatedAt - +a.updatedAt);
    return rows.map((d) => toDto(d, auth.userId));
  });

  // Fetch a single design — used when a deep-link route is added later.
  app.get<{ Params: { id: string } }>(
    '/admin/qr-designs/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const design = await db.query.qrDesigns.findFirst({
        where: eq(schema.qrDesigns.id, request.params.id),
        with: { organization: true, owner: true },
      });
      if (!design) return reply.notFound();
      requireOrgInScope(scope, design.organizationId);
      return toDto(design, auth.userId);
    },
  );

  // Create. The caller's home org is the default; platform admins can
  // create against any org in their scope. The spec is stored verbatim.
  app.post<{
    Body: {
      organizationId?: string;
      name: string;
      spec: Record<string, unknown>;
    };
  }>(
    '/admin/qr-designs',
    {
      // Bump body limit slightly above MAX_SPEC_BYTES so legitimate large
      // logos pass through; we still validate the JSON size precisely
      // inside SpecSchema.
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        body: z.object({
          organizationId: UuidSchema.optional(),
          name: NameSchema,
          spec: SpecSchema,
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const targetOrgId = request.body.organizationId ?? auth.organizationId;
      requireOrgInScope(scope, targetOrgId);

      const [created] = await db
        .insert(schema.qrDesigns)
        .values({
          organizationId: targetOrgId,
          ownerUserId: auth.userId,
          name: request.body.name,
          spec: request.body.spec,
        })
        .returning();
      if (!created) return reply.internalServerError();
      const full = await db.query.qrDesigns.findFirst({
        where: eq(schema.qrDesigns.id, created.id),
        with: { organization: true, owner: true },
      });
      if (!full) return reply.internalServerError();
      return toDto(full, auth.userId);
    },
  );

  // Update. Owner-only (platform admins bypass via scope.all). The route
  // accepts any subset of fields — typically the designer sends both name
  // and spec on every save.
  app.patch<{
    Params: { id: string };
    Body: { name?: string; spec?: Record<string, unknown> };
  }>(
    '/admin/qr-designs/:id',
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          name: NameSchema.optional(),
          spec: SpecSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const design = await db.query.qrDesigns.findFirst({
        where: eq(schema.qrDesigns.id, request.params.id),
      });
      if (!design) return reply.notFound();
      requireOrgInScope(scope, design.organizationId);
      assertCanMutate(design, auth);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (request.body.name !== undefined) patch.name = request.body.name;
      if (request.body.spec !== undefined) patch.spec = request.body.spec;
      await db
        .update(schema.qrDesigns)
        .set(patch)
        .where(eq(schema.qrDesigns.id, design.id));

      const updated = await db.query.qrDesigns.findFirst({
        where: eq(schema.qrDesigns.id, design.id),
        with: { organization: true, owner: true },
      });
      if (!updated) return reply.internalServerError();
      return toDto(updated, auth.userId);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/qr-designs/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const design = await db.query.qrDesigns.findFirst({
        where: eq(schema.qrDesigns.id, request.params.id),
      });
      if (!design) return reply.notFound();
      requireOrgInScope(scope, design.organizationId);
      assertCanMutate(design, auth);
      await db.delete(schema.qrDesigns).where(eq(schema.qrDesigns.id, design.id));
      return { ok: true };
    },
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface DesignWithRelations {
  id: string;
  organizationId: string;
  ownerUserId: string | null;
  name: string;
  spec: unknown;
  createdAt: Date;
  updatedAt: Date;
  organization: { id: string; name: string };
  owner: { id: string; displayName: string; email: string } | null;
}

function toDto(d: DesignWithRelations, requesterId: string) {
  return {
    id: d.id,
    organizationId: d.organizationId,
    organizationName: d.organization.name,
    ownerUserId: d.ownerUserId,
    ownerDisplayName: d.owner?.displayName ?? null,
    ownerEmail: d.owner?.email ?? null,
    /** True when the requester is the owner — drives the UI hint on whether
     *  they can edit/delete without having to call PATCH and watch it 403. */
    canEdit: d.ownerUserId === null || d.ownerUserId === requesterId,
    name: d.name,
    spec: d.spec,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function assertCanMutate(
  design: { ownerUserId: string | null; organizationId: string },
  auth: { userId: string; platformAdmin?: boolean | undefined },
): void {
  // Platform admins can always edit any design — needed for support cleanup.
  if (auth.platformAdmin === true) return;
  // Designs with a null owner (e.g. the original author was deleted) fall
  // back to "anyone in the org can edit" so the design doesn't become
  // permanently stranded.
  if (design.ownerUserId === null) return;
  if (design.ownerUserId === auth.userId) return;
  const err = new Error(
    "You can't edit a design saved by someone else. Ask the owner to update it, or save a copy.",
  ) as Error & { statusCode: number };
  err.statusCode = 403;
  throw err;
}
