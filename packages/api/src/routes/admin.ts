import type { FastifyInstance } from 'fastify';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';

// Derived structural role for a part. Lives alongside admin route definitions
// so the admin parts listing can use it inline; the PWA parts route re-uses
// it via the exported helper. Roles never touch the DB — they're purely a
// projection of part_components link presence.
export type PartRole = 'part' | 'assembly' | 'component' | 'sub_assembly';
export function deriveRole(hasChildren: boolean, hasParent: boolean): PartRole {
  if (hasChildren && hasParent) return 'sub_assembly';
  if (hasChildren) return 'assembly';
  if (hasParent) return 'component';
  return 'part';
}
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { isExtractable, processDocument } from '@platform/ai';
import { revalidateDocumentSections } from '../lib/section-revalidation-hook';
import { requireAuth } from '../middleware/auth';
import { getScope, orgIdsLiteral, requireOrgInScope } from '../middleware/scope';
import { createRateLimiter } from '../middleware/ratelimit';
import type { Storage } from '../storage';

// Pull a storage key into a Buffer. The extraction pipeline needs bytes in
// memory — file sizes are capped at upload (20 MB default) so this is fine.
async function fetchFileBuffer(storage: Storage, storageKey: string): Promise<Buffer> {
  const result = await storage.stream(storageKey);
  if (!result) throw new Error(`File not found in storage: ${storageKey}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Fire-and-forget extraction. We deliberately don't block the HTTP response
// on processing — extraction can take 5–30s for large PDFs. The admin UI
// polls documents.extractionStatus to show progress. Errors are captured
// into the document row, not thrown, so the process won't exit.
//
// Extra defensiveness: wrap everything in an IIFE with its own try/catch
// and write failures back to the row. Without this, an error thrown during
// module init or a sync exception path could escape processDocument's
// internal try/catch and kill the Node process.
function triggerExtraction(app: FastifyInstance, documentId: string): void {
  const { db, storage } = app.ctx;
  const startedAt = Date.now();
  app.log.info({ documentId }, 'extraction pipeline starting');

  (async () => {
    try {
      // Capture the doc's prior extracted text BEFORE processDocument
      // overwrites it. Section re-validation needs both old and new strings
      // to do per-page Jaccard comparison.
      const priorDoc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, documentId),
        columns: { extractedText: true },
      });
      const oldExtractedText = priorDoc?.extractedText ?? null;

      const result = await processDocument({
        db,
        documentId,
        fetchFile: (k) => fetchFileBuffer(storage, k),
      });
      const ms = Date.now() - startedAt;
      app.log.info(
        { documentId, ms, status: result.status, chunks: result.chunksWritten },
        'extraction pipeline completed',
      );

      // After a successful (or not-applicable, e.g. video) extraction, re-
      // validate any document_sections against the new content. We do this
      // for 'ready' AND 'not_applicable' so that adding a new section to a
      // video resolves immediately.
      if (result.status === 'ready' || result.status === 'not_applicable') {
        try {
          const summary = await revalidateDocumentSections({
            db,
            documentId,
            oldExtractedText,
          });
          if (summary.total > 0) {
            app.log.info(
              {
                documentId,
                total: summary.total,
                accepted: summary.accepted,
                flagged: summary.flagged,
                skipped: summary.skipped,
              },
              'document_sections re-validated',
            );
          }
        } catch (revalErr) {
          app.log.error(
            { err: revalErr, documentId },
            'document_sections re-validation threw — sections left in prior state',
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, documentId }, 'extraction pipeline threw');
      // Best-effort: mark the doc failed so the UI can show a real error
      // instead of leaving it stuck at 'processing'.
      try {
        await db
          .update(schema.documents)
          .set({ extractionStatus: 'failed', extractionError: msg })
          .where(eq(schema.documents.id, documentId));
      } catch (writeErr) {
        app.log.error({ err: writeErr, documentId }, 'failed to persist extraction failure');
      }
    }
  })();
}

export async function registerAdminRoutes(app: FastifyInstance) {
  // List asset instances with model + site info. Scoped: returns only
  // instances whose owning site belongs to an org the user can see (home
  // org + descendants via getScope). Platform admins see everything.
  app.get('/admin/asset-instances', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) return [];
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT ai.id, ai.serial_number,
                 am.id AS model_id, am.model_code, am.display_name AS model_display_name,
                 am.category AS model_category,
                 s.id AS site_id, s.name AS site_name,
                 o.id AS org_id, o.name AS org_name
              FROM asset_instances ai
              JOIN asset_models am ON am.id = ai.asset_model_id
              JOIN sites s ON s.id = ai.site_id
              JOIN organizations o ON o.id = s.organization_id
              ORDER BY am.display_name`
        : sql`SELECT ai.id, ai.serial_number,
                 am.id AS model_id, am.model_code, am.display_name AS model_display_name,
                 am.category AS model_category,
                 s.id AS site_id, s.name AS site_name,
                 o.id AS org_id, o.name AS org_name
              FROM asset_instances ai
              JOIN asset_models am ON am.id = ai.asset_model_id
              JOIN sites s ON s.id = ai.site_id
              JOIN organizations o ON o.id = s.organization_id
              WHERE s.organization_id = ANY(${scopeLiteral}::uuid[])
              ORDER BY am.display_name`,
    )) as unknown as Array<{
      id: string;
      serial_number: string;
      model_id: string;
      model_code: string;
      model_display_name: string;
      model_category: string;
      site_id: string;
      site_name: string;
      org_id: string;
      org_name: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      serialNumber: r.serial_number,
      assetModel: {
        id: r.model_id,
        modelCode: r.model_code,
        displayName: r.model_display_name,
        category: r.model_category,
      },
      site: { id: r.site_id, name: r.site_name },
      organization: { id: r.org_id, name: r.org_name },
    }));
  });

  // List QR codes with resolved asset instance. Scoped: a QR is visible only
  // when its linked asset instance's site belongs to an org in scope.
  // Unlinked QRs (no asset_instance_id) are visible only to platform admins —
  // scoped users have no org to attribute them to, and leaking a free-floating
  // code across tenants would defeat the scope guard.
  app.get('/admin/qr-codes', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) return [];
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT q.id, q.code, q.label, q.active, q.created_at, q.preferred_template_id,
                 ai.id AS instance_id, ai.serial_number,
                 am.display_name AS model_display_name,
                 am.category AS model_category,
                 s.name AS site_name,
                 tpl.name AS preferred_template_name
              FROM qr_codes q
              LEFT JOIN asset_instances ai ON ai.id = q.asset_instance_id
              LEFT JOIN asset_models am ON am.id = ai.asset_model_id
              LEFT JOIN sites s ON s.id = ai.site_id
              LEFT JOIN qr_label_templates tpl ON tpl.id = q.preferred_template_id
              ORDER BY q.created_at DESC`
        : sql`SELECT q.id, q.code, q.label, q.active, q.created_at, q.preferred_template_id,
                 ai.id AS instance_id, ai.serial_number,
                 am.display_name AS model_display_name,
                 am.category AS model_category,
                 s.name AS site_name,
                 tpl.name AS preferred_template_name
              FROM qr_codes q
              JOIN asset_instances ai ON ai.id = q.asset_instance_id
              JOIN asset_models am ON am.id = ai.asset_model_id
              JOIN sites s ON s.id = ai.site_id
              LEFT JOIN qr_label_templates tpl ON tpl.id = q.preferred_template_id
              WHERE s.organization_id = ANY(${scopeLiteral}::uuid[])
              ORDER BY q.created_at DESC`,
    )) as unknown as Array<{
      id: string;
      code: string;
      label: string | null;
      active: boolean;
      created_at: string;
      preferred_template_id: string | null;
      instance_id: string | null;
      serial_number: string | null;
      model_display_name: string | null;
      model_category: string | null;
      site_name: string | null;
      preferred_template_name: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      label: r.label,
      active: r.active,
      createdAt: r.created_at,
      preferredTemplate: r.preferred_template_id
        ? { id: r.preferred_template_id, name: r.preferred_template_name ?? 'Unknown' }
        : null,
      assetInstance: r.instance_id
        ? {
            id: r.instance_id,
            serialNumber: r.serial_number!,
            modelDisplayName: r.model_display_name!,
            modelCategory: r.model_category!,
            siteName: r.site_name!,
          }
        : null,
    }));
  });

  // Mint a new QR code for an asset instance.
  app.post<{
    Body: { assetInstanceId: string; label?: string; preferredTemplateId?: string | null };
  }>(
    '/admin/qr-codes',
    {
      schema: {
        body: z.object({
          assetInstanceId: UuidSchema,
          label: z.string().max(120).optional(),
          preferredTemplateId: UuidSchema.nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.body.assetInstanceId),
        with: { site: true },
      });
      if (!instance) return reply.notFound('Asset instance not found.');
      // Scope check: 404 (not 403) for out-of-scope instances — don't confirm
      // the row exists to a caller who shouldn't know about it.
      if (!scope.all && !scope.orgIds.includes(instance.site.organizationId)) {
        return reply.notFound('Asset instance not found.');
      }

      // If a template is provided, verify it lives in the caller's scope.
      // Otherwise a scoped admin could reference another org's template by
      // ID and leak the styling fingerprint.
      if (request.body.preferredTemplateId) {
        const tpl = await db.query.qrLabelTemplates.findFirst({
          where: eq(schema.qrLabelTemplates.id, request.body.preferredTemplateId),
        });
        if (!tpl) return reply.badRequest('Template not found.');
        requireOrgInScope(scope, tpl.organizationId);
      }

      const code = generateQrCode();
      const [created] = await db
        .insert(schema.qrCodes)
        .values({
          code,
          assetInstanceId: instance.id,
          label: request.body.label ?? null,
          preferredTemplateId: request.body.preferredTemplateId ?? null,
          active: true,
        })
        .returning();
      if (!created) return reply.internalServerError('Failed to mint QR code.');
      return created;
    },
  );

  // Update a QR code's label and/or preferred template. Lets an admin
  // re-brand a printed code's preferred design without re-minting — useful
  // when a new template rolls out and existing codes should reprint with it.
  app.patch<{
    Params: { id: string };
    Body: { label?: string | null; preferredTemplateId?: string | null };
  }>(
    '/admin/qr-codes/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          label: z.string().max(120).nullable().optional(),
          preferredTemplateId: UuidSchema.nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const qr = await db.query.qrCodes.findFirst({
        where: eq(schema.qrCodes.id, request.params.id),
        with: { assetInstance: { with: { site: true } } },
      });
      if (!qr) return reply.notFound();
      // Scope gate: the QR's owning org is the instance's site's org.
      // Orphaned QRs (no asset) are visible only to platform admins, which
      // matches the listing rules.
      if (!scope.all) {
        if (!qr.assetInstance) return reply.notFound();
        requireOrgInScope(scope, qr.assetInstance.site.organizationId);
      }

      if (request.body.preferredTemplateId) {
        const tpl = await db.query.qrLabelTemplates.findFirst({
          where: eq(schema.qrLabelTemplates.id, request.body.preferredTemplateId),
        });
        if (!tpl) return reply.badRequest('Template not found.');
        requireOrgInScope(scope, tpl.organizationId);
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (request.body.label !== undefined) patch.label = request.body.label;
      if (request.body.preferredTemplateId !== undefined) {
        patch.preferredTemplateId = request.body.preferredTemplateId;
      }

      const [updated] = await db
        .update(schema.qrCodes)
        .set(patch)
        .where(eq(schema.qrCodes.id, qr.id))
        .returning();
      return updated;
    },
  );

  // Delete a QR code. Hard delete is fine — the linked asset instance,
  // audit events, and content packs all carry on. Scanning the sticker
  // after delete just 404s, which is the correct signal when a sticker
  // has been retired (e.g. equipment decommissioned).
  app.delete<{ Params: { id: string } }>(
    '/admin/qr-codes/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const qr = await db.query.qrCodes.findFirst({
        where: eq(schema.qrCodes.id, request.params.id),
        with: { assetInstance: { with: { site: true } } },
      });
      if (!qr) return reply.notFound();
      if (!scope.all) {
        if (!qr.assetInstance) return reply.notFound();
        requireOrgInScope(scope, qr.assetInstance.site.organizationId);
      }

      await db.delete(schema.qrCodes).where(eq(schema.qrCodes.id, qr.id));
      return { ok: true };
    },
  );
}

// Opaque short code: Crockford-style base32, 12 chars, collision-rare enough
// for small fleets (10^18 space). If collisions matter at scale, swap to a
// retry loop with a UNIQUE check.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
function generateQrCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

// Create flows — onboarding an OEM / dealer / end-customer and standing up
// their asset fleet. Authoring of content (docs, training, parts) is still
// script-driven; those forms come later.
export async function registerAdminMutations(app: FastifyInstance) {
  const OrgTypeEnum = z.enum(['oem', 'dealer', 'integrator', 'end_customer']);

  // Update org branding — applied on the PWA when a scan resolves to an asset
  // owned by this org (or any of its child asset models).
  app.patch<{
    Params: { id: string };
    Body: {
      brandPrimary?: string | null;
      brandOnPrimary?: string | null;
      logoStorageKey?: string | null;
      displayNameOverride?: string | null;
    };
  }>(
    '/admin/organizations/:id/branding',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          brandPrimary: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/, 'hex color like #F77531')
            .nullable()
            .optional(),
          brandOnPrimary: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .nullable()
            .optional(),
          logoStorageKey: z.string().max(400).nullable().optional(),
          displayNameOverride: z.string().max(120).nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.params.id);

      const patch: Record<string, unknown> = {};
      if (request.body.brandPrimary !== undefined) patch.brandPrimary = request.body.brandPrimary;
      if (request.body.brandOnPrimary !== undefined) patch.brandOnPrimary = request.body.brandOnPrimary;
      if (request.body.logoStorageKey !== undefined) patch.logoStorageKey = request.body.logoStorageKey;
      if (request.body.displayNameOverride !== undefined) patch.displayNameOverride = request.body.displayNameOverride;

      const [updated] = await db
        .update(schema.organizations)
        .set(patch)
        .where(eq(schema.organizations.id, request.params.id))
        .returning();
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  // Privacy + access settings — scan-gate flag and Microsoft tenant mapping.
  // Tenant mapping is what drives per-org data scoping at sign-in: users
  // whose Microsoft tid matches an org's msft_tenant_id land in that org's
  // scope automatically. Both fields are patchable independently.
  app.patch<{
    Params: { id: string };
    Body: { requireScanAccess?: boolean; msftTenantId?: string | null };
  }>(
    '/admin/organizations/:id/privacy',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          requireScanAccess: z.boolean().optional(),
          // UUID-shaped but not necessarily a UUID in our schema; Microsoft
          // tenant IDs are UUIDs though. Null clears the mapping.
          msftTenantId: z
            .string()
            .regex(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
              'must be a Microsoft tenant UUID',
            )
            .nullable()
            .optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.params.id);

      // msftTenantId mapping is platform-admin-only. A scoped admin from org
      // A setting their own msftTenantId to org B's tenant would hijack
      // future sign-ins from that tenant into their own org. Even though
      // the DB has a UNIQUE constraint (preventing collision after the
      // legitimate org has set it), early-claiming is still an attack
      // vector, so we gate this field explicitly.
      if (request.body.msftTenantId !== undefined && !auth.platformAdmin) {
        return reply.forbidden('Only platform admins can change Microsoft tenant mapping.');
      }

      const patch: Record<string, unknown> = {};
      if (request.body.requireScanAccess !== undefined) {
        patch.requireScanAccess = request.body.requireScanAccess;
      }
      if (request.body.msftTenantId !== undefined) {
        patch.msftTenantId = request.body.msftTenantId;
      }
      if (Object.keys(patch).length === 0) {
        return reply.badRequest('No fields to update.');
      }
      const [updated] = await db
        .update(schema.organizations)
        .set(patch)
        .where(eq(schema.organizations.id, request.params.id))
        .returning();
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  app.post<{
    Body: {
      type: z.infer<typeof OrgTypeEnum>;
      name: string;
      slug: string;
      parentOrganizationId?: string;
      oemCode?: string;
    };
  }>(
    '/admin/organizations',
    {
      schema: {
        body: z.object({
          type: OrgTypeEnum,
          name: z.string().min(1).max(200),
          slug: z
            .string()
            .min(1)
            .max(60)
            .regex(/^[a-z0-9-]+$/, 'lowercase, digits, and hyphens only'),
          parentOrganizationId: UuidSchema.optional(),
          oemCode: z.string().max(60).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      // Only end_customers must declare a parent — they're always installed
      // by someone (integrator or OEM direct). OEMs and integrators are
      // top-level by default; dealers usually are too. See organizations.ts
      // schema comments for the full model.
      if (request.body.type === 'end_customer' && !request.body.parentOrganizationId) {
        return reply.badRequest(
          'End-customer organizations must specify a parent — typically the integrator or OEM that installed them.',
        );
      }

      // Scope guard: top-level (no parent) orgs can only be created by
      // platform admins — otherwise anyone could spin up a new standalone
      // tenant and escape scope. Non-top-level orgs must attach under a
      // parent that's already in the caller's scope tree.
      if (!request.body.parentOrganizationId) {
        if (!auth.platformAdmin) {
          return reply.forbidden(
            'Only platform admins can create top-level organizations (OEMs and independent integrators/dealers).',
          );
        }
      } else {
        requireOrgInScope(scope, request.body.parentOrganizationId);
      }

      const [created] = await db
        .insert(schema.organizations)
        .values({
          type: request.body.type,
          name: request.body.name,
          slug: request.body.slug,
          parentOrganizationId: request.body.parentOrganizationId ?? null,
          oemCode: request.body.oemCode ?? null,
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  app.post<{
    Body: {
      organizationId: string;
      name: string;
      code?: string;
      city?: string;
      region?: string;
      country?: string;
      postalCode?: string;
      timezone?: string;
    };
  }>(
    '/admin/sites',
    {
      schema: {
        body: z.object({
          organizationId: UuidSchema,
          name: z.string().min(1).max(200),
          code: z.string().max(40).optional(),
          city: z.string().max(120).optional(),
          region: z.string().max(120).optional(),
          country: z.string().max(2).optional(),
          postalCode: z.string().max(20).optional(),
          timezone: z.string().max(80).default('UTC'),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.body.organizationId);

      const [created] = await db
        .insert(schema.sites)
        .values({
          organizationId: request.body.organizationId,
          name: request.body.name,
          code: request.body.code ?? null,
          city: request.body.city ?? null,
          region: request.body.region ?? null,
          country: request.body.country ?? null,
          postalCode: request.body.postalCode ?? null,
          timezone: request.body.timezone ?? 'UTC',
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  app.post<{
    Body: {
      ownerOrganizationId: string;
      modelCode: string;
      displayName: string;
      category: string;
      description?: string;
      imageStorageKey?: string;
    };
  }>(
    '/admin/asset-models',
    {
      schema: {
        body: z.object({
          ownerOrganizationId: UuidSchema,
          modelCode: z.string().min(1).max(60),
          displayName: z.string().min(1).max(200),
          category: z.string().min(1).max(60),
          description: z.string().max(2000).optional(),
          imageStorageKey: z.string().max(400).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.body.ownerOrganizationId);

      const owner = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, request.body.ownerOrganizationId),
      });
      if (!owner) return reply.badRequest('Owner organization not found.');
      if (owner.type !== 'oem') {
        return reply.badRequest('Asset models must be owned by an OEM organization.');
      }

      const [created] = await db
        .insert(schema.assetModels)
        .values({
          ownerOrganizationId: owner.id,
          modelCode: request.body.modelCode,
          displayName: request.body.displayName,
          category: request.body.category,
          description: request.body.description ?? null,
          imageStorageKey: request.body.imageStorageKey ?? null,
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  // PATCH asset model image.
  app.patch<{ Params: { id: string }; Body: { imageStorageKey: string | null } }>(
    '/admin/asset-models/:id/image',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({ imageStorageKey: z.string().max(400).nullable() }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const model = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, request.params.id),
      });
      if (!model) return reply.notFound();
      requireOrgInScope(scope, model.ownerOrganizationId);
      const [updated] = await db
        .update(schema.assetModels)
        .set({ imageStorageKey: request.body.imageStorageKey })
        .where(eq(schema.assetModels.id, request.params.id))
        .returning();
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  // PATCH part image.
  app.patch<{ Params: { id: string }; Body: { imageStorageKey: string | null } }>(
    '/admin/parts/:id/image',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({ imageStorageKey: z.string().max(400).nullable() }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const part = await db.query.parts.findFirst({
        where: eq(schema.parts.id, request.params.id),
      });
      if (!part) return reply.notFound();
      requireOrgInScope(scope, part.ownerOrganizationId);
      const [updated] = await db
        .update(schema.parts)
        .set({ imageStorageKey: request.body.imageStorageKey })
        .where(eq(schema.parts.id, request.params.id))
        .returning();
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  app.post<{
    Body: {
      assetModelId: string;
      siteId: string;
      serialNumber: string;
      installedAt?: string;
      pinnedContentPackVersionId?: string;
    };
  }>(
    '/admin/asset-instances',
    {
      schema: {
        body: z.object({
          assetModelId: UuidSchema,
          siteId: UuidSchema,
          serialNumber: z.string().min(1).max(120),
          installedAt: z.string().datetime().optional(),
          pinnedContentPackVersionId: UuidSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      // Instances live at a site; the site's org is what owns the row for
      // scoping purposes. Verify the caller can administer that site's org.
      const site = await db.query.sites.findFirst({
        where: eq(schema.sites.id, request.body.siteId),
      });
      if (!site) return reply.badRequest('Site not found.');
      requireOrgInScope(scope, site.organizationId);

      // If no pinned version is provided, auto-pin to the latest published
      // base ContentPack for this asset model. Safe default so technicians who
      // scan the QR land on real content.
      const pinnedVersionId =
        request.body.pinnedContentPackVersionId ??
        (await findLatestPublishedVersionId(db, request.body.assetModelId));

      const [created] = await db
        .insert(schema.assetInstances)
        .values({
          assetModelId: request.body.assetModelId,
          siteId: request.body.siteId,
          serialNumber: request.body.serialNumber,
          installedAt: request.body.installedAt
            ? new Date(request.body.installedAt)
            : null,
          pinnedContentPackVersionId: pinnedVersionId ?? null,
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/asset-instances/:id/pin-latest',
    {
      schema: { params: z.object({ id: UuidSchema }) },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.id),
        with: { site: true },
      });
      if (!instance) return reply.notFound();
      requireOrgInScope(scope, instance.site.organizationId);
      const versionId = await findLatestPublishedVersionId(db, instance.assetModelId);
      if (!versionId) {
        return reply.badRequest(
          'No published content pack version exists for this asset model.',
        );
      }
      const [updated] = await db
        .update(schema.assetInstances)
        .set({ pinnedContentPackVersionId: versionId })
        .where(eq(schema.assetInstances.id, request.params.id))
        .returning();
      return updated;
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { pinnedContentPackVersionId: string | null };
  }>(
    '/admin/asset-instances/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          pinnedContentPackVersionId: UuidSchema.nullable(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.id),
        with: { site: true },
      });
      if (!instance) return reply.notFound();
      requireOrgInScope(scope, instance.site.organizationId);
      const [updated] = await db
        .update(schema.assetInstances)
        .set({ pinnedContentPackVersionId: request.body.pinnedContentPackVersionId })
        .where(eq(schema.assetInstances.id, request.params.id))
        .returning();
      if (!updated) return reply.notFound();
      return updated;
    },
  );

  app.post<{
    Body: {
      assetModelId: string;
      siteId: string;
      serialNumbers: string[];
      installedAt?: string;
      pinnedContentPackVersionId?: string;
    };
  }>(
    '/admin/asset-instances/bulk',
    {
      schema: {
        body: z.object({
          assetModelId: UuidSchema,
          siteId: UuidSchema,
          serialNumbers: z.array(z.string().min(1).max(120)).min(1).max(2000),
          installedAt: z.string().datetime().optional(),
          pinnedContentPackVersionId: UuidSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const site = await db.query.sites.findFirst({
        where: eq(schema.sites.id, request.body.siteId),
      });
      if (!site) return reply.badRequest('Site not found.');
      requireOrgInScope(scope, site.organizationId);

      const pinnedVersionId =
        request.body.pinnedContentPackVersionId ??
        (await findLatestPublishedVersionId(db, request.body.assetModelId));

      const installedAt = request.body.installedAt
        ? new Date(request.body.installedAt)
        : null;

      // Deduplicate and insert-or-ignore so a partial overlap with existing
      // serials doesn't blow up the whole import. Returns the newly-created
      // rows (existing ones are silently skipped).
      const unique = [...new Set(request.body.serialNumbers.map((s) => s.trim()))].filter(
        Boolean,
      );
      const created = await db
        .insert(schema.assetInstances)
        .values(
          unique.map((serialNumber) => ({
            assetModelId: request.body.assetModelId,
            siteId: request.body.siteId,
            serialNumber,
            installedAt,
            pinnedContentPackVersionId: pinnedVersionId ?? null,
          })),
        )
        .onConflictDoNothing({
          target: [schema.assetInstances.assetModelId, schema.assetInstances.serialNumber],
        })
        .returning();

      return {
        attempted: unique.length,
        created: created.length,
        skipped: unique.length - created.length,
        instances: created,
      };
    },
  );

  // Instances for an asset model (for the model detail page).
  app.get<{ Params: { modelId: string } }>(
    '/admin/asset-models/:modelId/instances',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const rows = await db.query.assetInstances.findMany({
        where: eq(schema.assetInstances.assetModelId, request.params.modelId),
        with: {
          site: { with: { organization: true } },
          pinnedContentPackVersion: true,
        },
      });
      return rows.map((r) => ({
        id: r.id,
        serialNumber: r.serialNumber,
        installedAt: r.installedAt,
        site: {
          id: r.site.id,
          name: r.site.name,
          organization: r.site.organization.name,
        },
        pinnedVersion: r.pinnedContentPackVersion
          ? {
              id: r.pinnedContentPackVersion.id,
              number: r.pinnedContentPackVersion.versionNumber,
              label: r.pinnedContentPackVersion.versionLabel,
            }
          : null,
      }));
    },
  );

  // Sites for a given org (for the org detail page and the bulk-import site picker).
  app.get<{ Params: { orgId: string } }>(
    '/admin/organizations/:orgId/sites',
    { schema: { params: z.object({ orgId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const rows = await db.query.sites.findMany({
        where: eq(schema.sites.organizationId, request.params.orgId),
      });
      return rows.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        city: s.city,
        region: s.region,
        country: s.country,
        timezone: s.timezone,
      }));
    },
  );

  // Sites across orgs the user can see (for the asset-instance site picker —
  // the onboarding flow usually assigns Flow Turn conveyors to an Amazon DC,
  // which is a different org than Flow Turn itself). Platform admins see all.
  app.get('/admin/sites', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) return [];
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT s.id, s.name, s.code, s.organization_id,
                 o.name AS organization_name, o.type AS organization_type
              FROM sites s
              JOIN organizations o ON o.id = s.organization_id
              ORDER BY o.name, s.name`
        : sql`SELECT s.id, s.name, s.code, s.organization_id,
                 o.name AS organization_name, o.type AS organization_type
              FROM sites s
              JOIN organizations o ON o.id = s.organization_id
              WHERE s.organization_id = ANY(${scopeLiteral}::uuid[])
              ORDER BY o.name, s.name`,
    )) as unknown as Array<{
      id: string;
      name: string;
      code: string | null;
      organization_id: string;
      organization_name: string;
      organization_type: string;
    }>;
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      organizationId: s.organization_id,
      organizationName: s.organization_name,
      organizationType: s.organization_type,
    }));
  });
}

// Training module, parts, BOM, and work-order authoring. Kept separate from
// the main content/pack authoring flow to keep registrars small.
export async function registerAdminTrainingAuthoring(app: FastifyInstance) {
  // Create training module inside a draft content pack version.
  app.post<{
    Params: { versionId: string };
    Body: {
      title: string;
      description?: string;
      estimatedMinutes?: number;
      competencyTag?: string;
      passThreshold?: number;
      orderingHint?: number;
    };
  }>(
    '/admin/content-pack-versions/:versionId/training-modules',
    {
      schema: {
        params: z.object({ versionId: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
          estimatedMinutes: z.number().int().min(0).max(9999).optional(),
          competencyTag: z.string().max(120).optional(),
          passThreshold: z.number().min(0).max(1).default(0.8),
          orderingHint: z.number().int().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);
      if (version.status !== 'draft') {
        return reply.badRequest('Can only author modules in a draft version.');
      }
      const [created] = await db
        .insert(schema.trainingModules)
        .values({
          contentPackVersionId: version.id,
          title: request.body.title,
          description: request.body.description ?? null,
          estimatedMinutes: request.body.estimatedMinutes ?? null,
          competencyTag: request.body.competencyTag ?? null,
          passThreshold: request.body.passThreshold,
          orderingHint: request.body.orderingHint,
        })
        .returning();
      return created;
    },
  );

  // Add a lesson to a module.
  app.post<{
    Params: { moduleId: string };
    Body: { title: string; bodyMarkdown?: string; orderingHint?: number };
  }>(
    '/admin/training-modules/:moduleId/lessons',
    {
      schema: {
        params: z.object({ moduleId: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200),
          bodyMarkdown: z.string().max(400000).optional(),
          orderingHint: z.number().int().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.moduleId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);
      if (module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only author lessons in a draft version.');
      }
      const [created] = await db
        .insert(schema.lessons)
        .values({
          trainingModuleId: request.params.moduleId,
          title: request.body.title,
          bodyMarkdown: request.body.bodyMarkdown ?? null,
          orderingHint: request.body.orderingHint,
        })
        .returning();
      return created;
    },
  );

  // Add a quiz activity to a module. MVP supports quiz kind only; other
  // activity kinds can be added later with their own endpoints.
  app.post<{
    Params: { moduleId: string };
    Body: {
      title: string;
      questions: Array<{
        prompt: string;
        options: string[];
        correctIndex: number;
        explanation?: string;
      }>;
      weight?: number;
      orderingHint?: number;
    };
  }>(
    '/admin/training-modules/:moduleId/quiz-activities',
    {
      schema: {
        params: z.object({ moduleId: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200),
          questions: z
            .array(
              z.object({
                prompt: z.string().min(1),
                options: z.array(z.string().min(1)).min(2).max(8),
                correctIndex: z.number().int().nonnegative(),
                explanation: z.string().optional(),
              }),
            )
            .min(1),
          weight: z.number().positive().default(1),
          orderingHint: z.number().int().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.moduleId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);
      if (module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only author activities in a draft version.');
      }
      const [created] = await db
        .insert(schema.activities)
        .values({
          trainingModuleId: request.params.moduleId,
          kind: 'quiz',
          title: request.body.title,
          config: { questions: request.body.questions },
          weight: request.body.weight,
          orderingHint: request.body.orderingHint,
        })
        .returning();
      return created;
    },
  );

  // Full training module detail: module metadata, lessons, activities.
  // Single round-trip so the authoring page renders without waterfalls.
  app.get<{ Params: { id: string } }>(
    '/admin/training-modules/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);
      const [lessonRows, activityRows] = await Promise.all([
        db.query.lessons.findMany({
          where: eq(schema.lessons.trainingModuleId, module.id),
        }),
        db.query.activities.findMany({
          where: eq(schema.activities.trainingModuleId, module.id),
        }),
      ]);
      lessonRows.sort(
        (a, b) => a.orderingHint - b.orderingHint || a.title.localeCompare(b.title),
      );
      activityRows.sort(
        (a, b) => a.orderingHint - b.orderingHint || a.title.localeCompare(b.title),
      );
      return {
        id: module.id,
        title: module.title,
        description: module.description,
        estimatedMinutes: module.estimatedMinutes,
        competencyTag: module.competencyTag,
        passThreshold: module.passThreshold,
        orderingHint: module.orderingHint,
        contentPack: {
          id: module.packVersion.pack.id,
          name: module.packVersion.pack.name,
          versionNumber: module.packVersion.versionNumber,
          versionLabel: module.packVersion.versionLabel,
          status: module.packVersion.status,
        },
        lessons: lessonRows,
        activities: activityRows,
      };
    },
  );

  // Update module metadata (title, description, threshold, etc.).
  // Content is still frozen once the containing version is published.
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      description?: string | null;
      estimatedMinutes?: number | null;
      competencyTag?: string | null;
      passThreshold?: number;
      orderingHint?: number;
    };
  }>(
    '/admin/training-modules/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(2000).nullable().optional(),
          estimatedMinutes: z.number().int().min(0).max(9999).nullable().optional(),
          competencyTag: z.string().max(120).nullable().optional(),
          passThreshold: z.number().min(0).max(1).optional(),
          orderingHint: z.number().int().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);
      if (module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only edit modules in a draft version.');
      }
      const patch: Record<string, unknown> = {};
      if (request.body.title !== undefined) patch.title = request.body.title;
      if (request.body.description !== undefined) patch.description = request.body.description;
      if (request.body.estimatedMinutes !== undefined)
        patch.estimatedMinutes = request.body.estimatedMinutes;
      if (request.body.competencyTag !== undefined)
        patch.competencyTag = request.body.competencyTag;
      if (request.body.passThreshold !== undefined)
        patch.passThreshold = request.body.passThreshold;
      if (request.body.orderingHint !== undefined)
        patch.orderingHint = request.body.orderingHint;
      const [updated] = await db
        .update(schema.trainingModules)
        .set(patch)
        .where(eq(schema.trainingModules.id, module.id))
        .returning();
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/training-modules/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);
      if (module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only delete modules in a draft version.');
      }
      await db
        .delete(schema.trainingModules)
        .where(eq(schema.trainingModules.id, module.id));
      return { ok: true };
    },
  );

  // Lesson update / delete. Scoped to draft versions via the parent module.
  app.patch<{
    Params: { id: string };
    Body: { title?: string; bodyMarkdown?: string | null; orderingHint?: number };
  }>(
    '/admin/lessons/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200).optional(),
          bodyMarkdown: z.string().max(400000).nullable().optional(),
          orderingHint: z.number().int().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const lesson = await db.query.lessons.findFirst({
        where: eq(schema.lessons.id, request.params.id),
        with: { module: { with: { packVersion: { with: { pack: true } } } } },
      });
      if (!lesson) return reply.notFound();
      requireOrgInScope(scope, lesson.module.packVersion.pack.ownerOrganizationId);
      if (lesson.module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only edit lessons in a draft version.');
      }
      const patch: Record<string, unknown> = {};
      if (request.body.title !== undefined) patch.title = request.body.title;
      if (request.body.bodyMarkdown !== undefined)
        patch.bodyMarkdown = request.body.bodyMarkdown;
      if (request.body.orderingHint !== undefined)
        patch.orderingHint = request.body.orderingHint;
      const [updated] = await db
        .update(schema.lessons)
        .set(patch)
        .where(eq(schema.lessons.id, lesson.id))
        .returning();
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/lessons/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const lesson = await db.query.lessons.findFirst({
        where: eq(schema.lessons.id, request.params.id),
        with: { module: { with: { packVersion: { with: { pack: true } } } } },
      });
      if (!lesson) return reply.notFound();
      requireOrgInScope(scope, lesson.module.packVersion.pack.ownerOrganizationId);
      if (lesson.module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only delete lessons in a draft version.');
      }
      await db.delete(schema.lessons).where(eq(schema.lessons.id, lesson.id));
      return { ok: true };
    },
  );

  // Quiz activity update / delete. Same draft-only constraint.
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      questions?: Array<{
        prompt: string;
        options: string[];
        correctIndex: number;
        explanation?: string;
      }>;
      weight?: number;
      orderingHint?: number;
    };
  }>(
    '/admin/activities/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          title: z.string().min(1).max(200).optional(),
          questions: z
            .array(
              z.object({
                prompt: z.string().min(1),
                options: z.array(z.string().min(1)).min(2).max(8),
                correctIndex: z.number().int().nonnegative(),
                explanation: z.string().optional(),
              }),
            )
            .min(1)
            .optional(),
          weight: z.number().positive().optional(),
          orderingHint: z.number().int().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const activity = await db.query.activities.findFirst({
        where: eq(schema.activities.id, request.params.id),
        with: { module: { with: { packVersion: { with: { pack: true } } } } },
      });
      if (!activity) return reply.notFound();
      requireOrgInScope(scope, activity.module.packVersion.pack.ownerOrganizationId);
      if (activity.module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only edit activities in a draft version.');
      }
      const patch: Record<string, unknown> = {};
      if (request.body.title !== undefined) patch.title = request.body.title;
      if (request.body.weight !== undefined) patch.weight = request.body.weight;
      if (request.body.orderingHint !== undefined)
        patch.orderingHint = request.body.orderingHint;
      if (request.body.questions !== undefined) {
        patch.config = { ...activity.config, questions: request.body.questions };
      }
      const [updated] = await db
        .update(schema.activities)
        .set(patch)
        .where(eq(schema.activities.id, activity.id))
        .returning();
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/activities/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const activity = await db.query.activities.findFirst({
        where: eq(schema.activities.id, request.params.id),
        with: { module: { with: { packVersion: { with: { pack: true } } } } },
      });
      if (!activity) return reply.notFound();
      requireOrgInScope(scope, activity.module.packVersion.pack.ownerOrganizationId);
      if (activity.module.packVersion.status !== 'draft') {
        return reply.badRequest('Can only delete activities in a draft version.');
      }
      await db.delete(schema.activities).where(eq(schema.activities.id, activity.id));
      return { ok: true };
    },
  );

  // List all parts owned by a given OEM — for the BOM picker on asset models.
  app.get<{ Querystring: { ownerId?: string } }>(
    '/admin/parts/by-owner',
    { schema: { querystring: z.object({ ownerId: UuidSchema.optional() }) } },
    async (request) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const rows = request.query.ownerId
        ? await db.query.parts.findMany({
            where: eq(schema.parts.ownerOrganizationId, request.query.ownerId),
          })
        : await db.query.parts.findMany();
      return rows.map((p) => ({
        id: p.id,
        oemPartNumber: p.oemPartNumber,
        displayName: p.displayName,
        description: p.description,
        imageUrl: p.imageStorageKey ? storage.publicUrl(p.imageStorageKey) : null,
      }));
    },
  );

  // Create a new part.
  app.post<{
    Body: {
      ownerOrganizationId: string;
      oemPartNumber: string;
      displayName: string;
      description?: string;
      crossReferences?: string[];
      imageStorageKey?: string;
    };
  }>(
    '/admin/parts',
    {
      schema: {
        body: z.object({
          ownerOrganizationId: UuidSchema,
          oemPartNumber: z.string().min(1).max(120),
          displayName: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
          crossReferences: z.array(z.string().max(120)).max(24).default([]),
          imageStorageKey: z.string().max(400).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.body.ownerOrganizationId);
      const [created] = await db
        .insert(schema.parts)
        .values({
          ownerOrganizationId: request.body.ownerOrganizationId,
          oemPartNumber: request.body.oemPartNumber,
          displayName: request.body.displayName,
          description: request.body.description ?? null,
          crossReferences: request.body.crossReferences ?? [],
          imageStorageKey: request.body.imageStorageKey ?? null,
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  // List an asset model's BOM entries (with part details) for the BOM manager.
  app.get<{ Params: { modelId: string } }>(
    '/admin/asset-models/:modelId/bom',
    { schema: { params: z.object({ modelId: UuidSchema }) } },
    async (request) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const entries = await db.query.bomEntries.findMany({
        where: eq(schema.bomEntries.assetModelId, request.params.modelId),
      });
      if (entries.length === 0) return [];
      const parts = await db.query.parts.findMany({
        where: inArray(
          schema.parts.id,
          [...new Set(entries.map((e) => e.partId))],
        ),
      });
      const byId = new Map(parts.map((p) => [p.id, p]));
      return entries.map((e) => {
        const p = byId.get(e.partId);
        return {
          bomEntryId: e.id,
          partId: e.partId,
          positionRef: e.positionRef,
          quantity: e.quantity,
          notes: e.notes,
          oemPartNumber: p?.oemPartNumber ?? null,
          displayName: p?.displayName ?? 'Unknown part',
          imageUrl: p?.imageStorageKey ? storage.publicUrl(p.imageStorageKey) : null,
        };
      });
    },
  );

  // Assign an existing part to an asset model's BOM.
  app.post<{
    Params: { modelId: string };
    Body: {
      partId: string;
      positionRef?: string;
      quantity: number;
      notes?: string;
    };
  }>(
    '/admin/asset-models/:modelId/bom',
    {
      schema: {
        params: z.object({ modelId: UuidSchema }),
        body: z.object({
          partId: UuidSchema,
          positionRef: z.string().max(60).optional(),
          quantity: z.number().int().min(1).default(1),
          notes: z.string().max(400).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const model = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, request.params.modelId),
      });
      if (!model) return reply.notFound();
      requireOrgInScope(scope, model.ownerOrganizationId);
      // Also ensure the part being attached is in scope — prevents pulling
      // another org's parts into your BOM.
      const part = await db.query.parts.findFirst({
        where: eq(schema.parts.id, request.body.partId),
      });
      if (!part) return reply.badRequest('Part not found.');
      requireOrgInScope(scope, part.ownerOrganizationId);
      const [created] = await db
        .insert(schema.bomEntries)
        .values({
          assetModelId: request.params.modelId,
          partId: request.body.partId,
          positionRef: request.body.positionRef ?? null,
          quantity: request.body.quantity,
          notes: request.body.notes ?? null,
        })
        .returning();
      return created;
    },
  );

  // Remove a BOM entry.
  app.delete<{ Params: { id: string } }>(
    '/admin/bom-entries/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const entry = await db.query.bomEntries.findFirst({
        where: eq(schema.bomEntries.id, request.params.id),
        with: { assetModel: true },
      });
      if (!entry) return reply.notFound();
      requireOrgInScope(scope, entry.assetModel.ownerOrganizationId);
      await db.delete(schema.bomEntries).where(eq(schema.bomEntries.id, request.params.id));
      return { ok: true };
    },
  );

  // ----- Part Components (parent → children hierarchy) ---------------------
  // Drives the drill-down in the PWA part hub: Motor → Bearing → inner race…

  app.get<{ Params: { partId: string } }>(
    '/admin/parts/:partId/components',
    { schema: { params: z.object({ partId: UuidSchema }) } },
    async (request) => {
      const { db, storage } = app.ctx;
      requireAuth(request);
      const links = await db.query.partComponents.findMany({
        where: eq(schema.partComponents.parentPartId, request.params.partId),
      });
      if (links.length === 0) return [];
      const childIds = [...new Set(links.map((l) => l.childPartId))];
      const children = await db.query.parts.findMany({
        where: inArray(schema.parts.id, childIds),
      });
      const byId = new Map(children.map((p) => [p.id, p]));
      // Sort by ordering_hint then by child name for stable UI.
      const mapped = links
        .map((l) => {
          const child = byId.get(l.childPartId);
          if (!child) return null;
          return {
            linkId: l.id,
            childPartId: child.id,
            oemPartNumber: child.oemPartNumber,
            displayName: child.displayName,
            description: child.description,
            positionRef: l.positionRef,
            quantity: l.quantity,
            notes: l.notes,
            orderingHint: l.orderingHint,
            imageUrl: child.imageStorageKey ? storage.publicUrl(child.imageStorageKey) : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      mapped.sort(
        (a, b) => a.orderingHint - b.orderingHint || a.displayName.localeCompare(b.displayName),
      );
      return mapped;
    },
  );

  app.post<{
    Params: { partId: string };
    Body: {
      childPartId: string;
      positionRef?: string;
      quantity: number;
      notes?: string;
      orderingHint?: number;
    };
  }>(
    '/admin/parts/:partId/components',
    {
      schema: {
        params: z.object({ partId: UuidSchema }),
        body: z.object({
          childPartId: UuidSchema,
          positionRef: z.string().max(60).optional(),
          quantity: z.number().int().min(1).default(1),
          notes: z.string().max(400).optional(),
          orderingHint: z.number().int().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const { partId } = request.params;
      if (partId === request.body.childPartId) {
        return reply.badRequest('A part cannot be its own component.');
      }
      // Both parent and child must live in an org the caller can admin —
      // otherwise a scoped admin could wire another tenant's parts into
      // their own hierarchy (or inject their parts into a tenant's tree).
      const both = await db.query.parts.findMany({
        where: inArray(schema.parts.id, [partId, request.body.childPartId]),
      });
      const parent = both.find((p) => p.id === partId);
      const child = both.find((p) => p.id === request.body.childPartId);
      if (!parent || !child) return reply.notFound();
      requireOrgInScope(scope, parent.ownerOrganizationId);
      requireOrgInScope(scope, child.ownerOrganizationId);

      const [created] = await db
        .insert(schema.partComponents)
        .values({
          parentPartId: partId,
          childPartId: request.body.childPartId,
          positionRef: request.body.positionRef ?? null,
          quantity: request.body.quantity,
          notes: request.body.notes ?? null,
          orderingHint: request.body.orderingHint ?? 0,
        })
        .returning();
      return created;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/part-components/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const link = await db.query.partComponents.findFirst({
        where: eq(schema.partComponents.id, request.params.id),
      });
      if (!link) return reply.notFound();
      const parent = await db.query.parts.findFirst({
        where: eq(schema.parts.id, link.parentPartId),
      });
      if (!parent) return reply.notFound();
      requireOrgInScope(scope, parent.ownerOrganizationId);
      await db
        .delete(schema.partComponents)
        .where(eq(schema.partComponents.id, request.params.id));
      return { ok: true };
    },
  );

  // ----- Part ↔ Document links ---------------------------------------------
  // These back the "link parts" authoring flow on the admin content-pack
  // detail page and the "docs for this part" lookup on the PWA parts overlay.

  // List the documents linked to a specific part. Returns docs with their
  // version context so the admin UI can show which version each lives in.
  app.get<{ Params: { partId: string } }>(
    '/admin/parts/:partId/documents',
    { schema: { params: z.object({ partId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const links = await db.query.partDocuments.findMany({
        where: eq(schema.partDocuments.partId, request.params.partId),
      });
      if (links.length === 0) return [];
      const docIds = [...new Set(links.map((l) => l.documentId))];
      const docs = await db.query.documents.findMany({
        where: inArray(schema.documents.id, docIds),
        with: { packVersion: { with: { pack: true } } },
      });
      const byId = new Map(docs.map((d) => [d.id, d]));
      return links
        .map((l) => {
          const d = byId.get(l.documentId);
          if (!d) return null;
          return {
            linkId: l.id,
            documentId: d.id,
            title: d.title,
            kind: d.kind,
            safetyCritical: d.safetyCritical,
            contentPackVersionId: d.contentPackVersionId,
            packName: d.packVersion.pack.name,
            versionNumber: d.packVersion.versionNumber,
            versionLabel: d.packVersion.versionLabel,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    },
  );

  // List the parts linked to a specific document. Powers the inverse view —
  // the admin content-pack page shows each doc with a "linked parts" count.
  app.get<{ Params: { documentId: string } }>(
    '/admin/documents/:documentId/parts',
    { schema: { params: z.object({ documentId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const links = await db.query.partDocuments.findMany({
        where: eq(schema.partDocuments.documentId, request.params.documentId),
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

  // Replace the full set of parts linked to a document in one call. The admin
  // drawer loads the current set, the author toggles checkboxes, saves — this
  // endpoint is what the save hits. Using a set-replace semantics (vs. per-
  // link add/remove) keeps the drawer's UX simple and the wire-protocol honest.
  app.put<{
    Params: { documentId: string };
    Body: { partIds: string[] };
  }>(
    '/admin/documents/:documentId/parts',
    {
      schema: {
        params: z.object({ documentId: UuidSchema }),
        body: z.object({ partIds: z.array(UuidSchema) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const documentId = request.params.documentId;
      const wanted = new Set(request.body.partIds);

      // Doc's org must be in scope.
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, documentId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);

      // Every part being linked must also be in scope — prevents pulling a
      // competing org's parts into your documents.
      if (wanted.size > 0) {
        const parts = await db.query.parts.findMany({
          where: inArray(schema.parts.id, [...wanted]),
        });
        if (parts.length !== wanted.size) {
          return reply.notFound('One or more parts not found.');
        }
        for (const p of parts) requireOrgInScope(scope, p.ownerOrganizationId);
      }

      await db.transaction(async (tx) => {
        const existing = await tx.query.partDocuments.findMany({
          where: eq(schema.partDocuments.documentId, documentId),
        });
        const existingIds = new Set(existing.map((e) => e.partId));
        const toDelete = existing.filter((e) => !wanted.has(e.partId));
        const toInsert = [...wanted].filter((pid) => !existingIds.has(pid));

        if (toDelete.length > 0) {
          await tx.delete(schema.partDocuments).where(
            inArray(
              schema.partDocuments.id,
              toDelete.map((d) => d.id),
            ),
          );
        }
        if (toInsert.length > 0) {
          await tx.insert(schema.partDocuments).values(
            toInsert.map((partId) => ({ documentId, partId })),
          );
        }
      });

      return { ok: true, count: wanted.size };
    },
  );

  // ----- Part ↔ TrainingModule links ---------------------------------------
  // Same shape as documents; separated for clarity and to keep the admin
  // drawers distinct (training modules aren't browseable as docs).

  app.get<{ Params: { partId: string } }>(
    '/admin/parts/:partId/training-modules',
    { schema: { params: z.object({ partId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const links = await db.query.partTrainingModules.findMany({
        where: eq(schema.partTrainingModules.partId, request.params.partId),
      });
      if (links.length === 0) return [];
      const moduleIds = [...new Set(links.map((l) => l.trainingModuleId))];
      const modules = await db.query.trainingModules.findMany({
        where: inArray(schema.trainingModules.id, moduleIds),
        with: { packVersion: { with: { pack: true } } },
      });
      const byId = new Map(modules.map((m) => [m.id, m]));
      return links
        .map((l) => {
          const m = byId.get(l.trainingModuleId);
          if (!m) return null;
          return {
            linkId: l.id,
            trainingModuleId: m.id,
            title: m.title,
            contentPackVersionId: m.contentPackVersionId,
            packName: m.packVersion.pack.name,
            versionNumber: m.packVersion.versionNumber,
            versionLabel: m.packVersion.versionLabel,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    },
  );

  app.get<{ Params: { moduleId: string } }>(
    '/admin/training-modules/:moduleId/parts',
    { schema: { params: z.object({ moduleId: UuidSchema }) } },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const links = await db.query.partTrainingModules.findMany({
        where: eq(schema.partTrainingModules.trainingModuleId, request.params.moduleId),
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

  app.put<{
    Params: { moduleId: string };
    Body: { partIds: string[] };
  }>(
    '/admin/training-modules/:moduleId/parts',
    {
      schema: {
        params: z.object({ moduleId: UuidSchema }),
        body: z.object({ partIds: z.array(UuidSchema) }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const moduleId = request.params.moduleId;
      const wanted = new Set(request.body.partIds);

      // Module's org must be in scope.
      const module = await db.query.trainingModules.findFirst({
        where: eq(schema.trainingModules.id, moduleId),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!module) return reply.notFound();
      requireOrgInScope(scope, module.packVersion.pack.ownerOrganizationId);

      // Every part being linked must also be in scope.
      if (wanted.size > 0) {
        const parts = await db.query.parts.findMany({
          where: inArray(schema.parts.id, [...wanted]),
        });
        if (parts.length !== wanted.size) {
          return reply.notFound('One or more parts not found.');
        }
        for (const p of parts) requireOrgInScope(scope, p.ownerOrganizationId);
      }

      await db.transaction(async (tx) => {
        const existing = await tx.query.partTrainingModules.findMany({
          where: eq(schema.partTrainingModules.trainingModuleId, moduleId),
        });
        const existingIds = new Set(existing.map((e) => e.partId));
        const toDelete = existing.filter((e) => !wanted.has(e.partId));
        const toInsert = [...wanted].filter((pid) => !existingIds.has(pid));

        if (toDelete.length > 0) {
          await tx.delete(schema.partTrainingModules).where(
            inArray(
              schema.partTrainingModules.id,
              toDelete.map((d) => d.id),
            ),
          );
        }
        if (toInsert.length > 0) {
          await tx.insert(schema.partTrainingModules).values(
            toInsert.map((partId) => ({ trainingModuleId: moduleId, partId })),
          );
        }
      });

      return { ok: true, count: wanted.size };
    },
  );

  // Admin-wide work order listing with asset + opener context.
  app.get<{ Querystring: { status?: 'open' | 'closed' | 'all' } }>(
    '/admin/work-orders',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['open', 'closed', 'all']).optional(),
        }),
      },
    },
    async (request) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      if (!scope.all && scope.orgIds.length === 0) return [];
      const filter = request.query.status ?? 'open';
      const openStatuses = ['open', 'acknowledged', 'in_progress', 'blocked'];
      const closedStatuses = ['resolved', 'closed'];
      const rows = await db.query.workOrders.findMany({
        ...(filter === 'all'
          ? {}
          : {
              where: inArray(
                schema.workOrders.status,
                filter === 'open' ? openStatuses : closedStatuses,
              ),
            }),
        with: {
          assetInstance: { with: { model: true, site: { with: { organization: true } } } },
          openedBy: true,
          assignedTo: true,
        },
      });
      // Filter in memory: the work-orders table doesn't carry an org column,
      // so we join through asset_instance → site → org. For platform admins
      // (scope.all), we keep everything; for scoped users, drop rows whose
      // instance's org isn't in scope.
      const scopedRows = scope.all
        ? rows
        : rows.filter((w) => scope.orgIds.includes(w.assetInstance.site.organizationId));
      scopedRows.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
      return scopedRows.map((w) => ({
        id: w.id,
        title: w.title,
        description: w.description,
        status: w.status,
        severity: w.severity,
        openedAt: w.openedAt,
        resolvedAt: w.resolvedAt,
        closedAt: w.closedAt,
        attachments: w.attachments,
        assetInstance: {
          id: w.assetInstance.id,
          serialNumber: w.assetInstance.serialNumber,
          modelDisplayName: w.assetInstance.model.displayName,
          modelCode: w.assetInstance.model.modelCode,
          siteName: w.assetInstance.site.name,
          organizationName: w.assetInstance.site.organization.name,
        },
        openedBy: w.openedBy
          ? { id: w.openedBy.id, displayName: w.openedBy.displayName }
          : null,
        assignedTo: w.assignedTo
          ? { id: w.assignedTo.id, displayName: w.assignedTo.displayName }
          : null,
      }));
    },
  );
}

// Authoring routes: content pack + version + document CRUD, publish transitions,
// and file uploads. Kept in a dedicated registrar so the API module boundary
// stays narrow.
export async function registerAdminAuthoring(app: FastifyInstance) {
  const DocumentKindEnum = z.enum([
    'markdown',
    'pdf',
    'video',
    'structured_procedure',
    'schematic',
    'slides',
    'file',
    'external_video',
  ]);

  // Multipart upload. Returns storage metadata the admin app feeds into document
  // creation. File content is stored content-addressed; callers get back a key
  // they can write to documents.storageKey.
  //
  // Rate-limited per user: uploads are the one admin endpoint that writes
  // non-trivial bytes to S3 on the caller's behalf. Without a cap, a
  // compromised or script-abusive admin account could drive storage costs
  // to the moon. 60/hour per user is comfortable for a human authoring
  // session and hostile to a loop.
  //
  // Platform admins (SANTECH staff) bypass the cap — they already skip
  // per-org scoping and are the tier we trust for bulk authoring and
  // backfills that would otherwise trip the limit.
  const uploadLimiter = createRateLimiter({ limit: 60, windowMs: 60 * 60 * 1000 });
  app.post('/admin/uploads', async (request, reply) => {
    const { storage } = app.ctx;
    const auth = requireAuth(request);

    if (!auth.platformAdmin) {
      const rl = uploadLimiter.check(auth.userId);
      if (!rl.allowed) {
        reply.header('Retry-After', rl.retryAfterSec);
        return reply.tooManyRequests(
          `Upload rate limit reached. Try again in ${rl.retryAfterSec}s.`,
        );
      }
    }

    const file = await request.file();
    if (!file) return reply.badRequest('No file provided.');

    const buffer = await file.toBuffer();
    const result = await storage.putBuffer({
      buffer,
      filename: file.filename ?? 'file',
      contentType: file.mimetype ?? 'application/octet-stream',
    });

    return {
      storageKey: result.storageKey,
      sha256: result.sha256,
      size: result.size,
      contentType: file.mimetype ?? 'application/octet-stream',
      originalFilename: file.filename ?? 'file',
      url: storage.publicUrl(result.storageKey),
    };
  });

  // Create a new ContentPack. Optionally also creates an initial draft version.
  app.post<{
    Body: {
      assetModelId: string;
      name: string;
      slug: string;
      layerType: 'base' | 'dealer_overlay' | 'site_overlay';
      basePackId?: string;
      createDraftVersion?: boolean;
    };
  }>(
    '/admin/content-packs',
    {
      schema: {
        body: z.object({
          assetModelId: UuidSchema,
          name: z.string().min(1).max(200),
          slug: z
            .string()
            .min(1)
            .max(80)
            .regex(/^[a-z0-9-]+$/),
          layerType: z.enum(['base', 'dealer_overlay', 'site_overlay']),
          basePackId: UuidSchema.optional(),
          createDraftVersion: z.boolean().default(true),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const assetModel = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, request.body.assetModelId),
      });
      if (!assetModel) return reply.badRequest('Asset model not found.');
      requireOrgInScope(scope, assetModel.ownerOrganizationId);
      if (request.body.layerType !== 'base' && !request.body.basePackId) {
        return reply.badRequest('Overlay packs must reference a base pack.');
      }

      const [pack] = await db
        .insert(schema.contentPacks)
        .values({
          assetModelId: request.body.assetModelId,
          ownerOrganizationId: assetModel.ownerOrganizationId,
          layerType: request.body.layerType,
          basePackId: request.body.basePackId ?? null,
          name: request.body.name,
          slug: request.body.slug,
        })
        .returning();
      if (!pack) return reply.internalServerError();

      let version: typeof schema.contentPackVersions.$inferSelect | undefined;
      if (request.body.createDraftVersion) {
        const [v] = await db
          .insert(schema.contentPackVersions)
          .values({
            contentPackId: pack.id,
            versionNumber: 1,
            versionLabel: '1.0.0',
            status: 'draft',
          })
          .returning();
        version = v;
      }

      return { pack, version: version ?? null };
    },
  );

  // Create a new draft version on an existing pack. The version number is
  // always max+1 — immutable history.
  app.post<{
    Params: { packId: string };
    Body: { versionLabel?: string; changelog?: string };
  }>(
    '/admin/content-packs/:packId/versions',
    {
      schema: {
        params: z.object({ packId: UuidSchema }),
        body: z.object({
          versionLabel: z.string().max(40).optional(),
          changelog: z.string().max(4000).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const pack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, request.params.packId),
      });
      if (!pack) return reply.notFound();
      requireOrgInScope(scope, pack.ownerOrganizationId);

      const versions = await db.query.contentPackVersions.findMany({
        where: eq(schema.contentPackVersions.contentPackId, request.params.packId),
      });
      const next = versions.length > 0
        ? Math.max(...versions.map((v) => v.versionNumber)) + 1
        : 1;

      const [created] = await db
        .insert(schema.contentPackVersions)
        .values({
          contentPackId: request.params.packId,
          versionNumber: next,
          versionLabel: request.body.versionLabel ?? `${next}.0.0`,
          changelog: request.body.changelog ?? null,
          status: 'draft',
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  // Add a document to a draft version. Fails if the version is already published.
  app.post<{
    Params: { versionId: string };
    Body: {
      kind: z.infer<typeof DocumentKindEnum>;
      title: string;
      bodyMarkdown?: string;
      storageKey?: string;
      externalUrl?: string;
      streamPlaybackId?: string;
      originalFilename?: string;
      contentType?: string;
      sizeBytes?: number;
      language?: string;
      safetyCritical?: boolean;
      orderingHint?: number;
      tags?: string[];
    };
  }>(
    '/admin/content-pack-versions/:versionId/documents',
    {
      schema: {
        params: z.object({ versionId: UuidSchema }),
        body: z.object({
          kind: DocumentKindEnum,
          title: z.string().min(1).max(200),
          bodyMarkdown: z.string().max(400000).optional(),
          storageKey: z.string().max(400).optional(),
          thumbnailStorageKey: z.string().max(400).optional(),
          externalUrl: z.string().url().max(2000).optional(),
          streamPlaybackId: z.string().max(200).optional(),
          originalFilename: z.string().max(400).optional(),
          contentType: z.string().max(200).optional(),
          sizeBytes: z.number().int().nonnegative().optional(),
          language: z.string().length(2).default('en'),
          safetyCritical: z.boolean().default(false),
          orderingHint: z.number().int().default(0),
          tags: z.array(z.string().max(80)).default([]),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);
      if (version.status !== 'draft') {
        return reply.badRequest(
          `Cannot add documents to a ${version.status} version. Open a new draft first.`,
        );
      }

      // Require that the kind has the right payload. Prevents orphan rows with
      // no renderable content.
      const b = request.body;
      const kindOk =
        (b.kind === 'markdown' && !!b.bodyMarkdown) ||
        (b.kind === 'structured_procedure' && !!b.bodyMarkdown) ||
        (b.kind === 'external_video' && !!b.externalUrl) ||
        (b.kind === 'video' && (!!b.storageKey || !!b.streamPlaybackId)) ||
        (['pdf', 'slides', 'file', 'schematic'].includes(b.kind) && !!b.storageKey);
      if (!kindOk) {
        return reply.badRequest(`Document kind "${b.kind}" is missing its payload field.`);
      }

      // Decide initial extraction state. Markdown/structured_procedure ground
      // off bodyMarkdown and need chunking too (for embedding). Binary docs
      // (pdf/pptx/docx/slides/schematic) need full extraction. Videos and
      // external URLs have no text the AI can retrieve from.
      const needsExtraction =
        b.kind === 'markdown' ||
        b.kind === 'structured_procedure' ||
        isExtractable(b.kind, b.contentType ?? null);
      const initialStatus = needsExtraction ? 'pending' : 'not_applicable';

      const [doc] = await db
        .insert(schema.documents)
        .values({
          contentPackVersionId: version.id,
          kind: b.kind,
          title: b.title,
          bodyMarkdown: b.bodyMarkdown ?? null,
          storageKey: b.storageKey ?? null,
          thumbnailStorageKey: b.thumbnailStorageKey ?? null,
          externalUrl: b.externalUrl ?? null,
          streamPlaybackId: b.streamPlaybackId ?? null,
          originalFilename: b.originalFilename ?? null,
          contentType: b.contentType ?? null,
          sizeBytes: b.sizeBytes ?? null,
          language: b.language,
          safetyCritical: b.safetyCritical,
          orderingHint: b.orderingHint,
          tags: b.tags,
          extractionStatus: initialStatus,
        })
        .returning();

      if (doc && needsExtraction) {
        triggerExtraction(app, doc.id);
      }
      return doc;
    },
  );

  // Re-run extraction for a single document. Useful when a failed job needs
  // retry, or after the extractor is updated. Accepts ready/failed/pending
  // docs; rejects 'processing' to avoid stepping on an in-flight job.
  app.post<{ Params: { id: string } }>(
    '/admin/documents/:id/reprocess',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
      // Note: we allow resetting a 'processing' doc. If a real job is mid-
      // flight (same container, same process), it'll race with the new job
      // and the transactional chunk-swap at the end picks a deterministic
      // winner. If the 'processing' status is stale (container restarted),
      // reset is the only way out.
      await db
        .update(schema.documents)
        .set({ extractionStatus: 'pending', extractionError: null })
        .where(eq(schema.documents.id, doc.id));

      triggerExtraction(app, doc.id);
      return { ok: true, documentId: doc.id };
    },
  );

  // Update a document (rename, swap file, etc.). Only allowed while the
  // parent version is still a draft — published versions are immutable.
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      storageKey?: string;
      thumbnailStorageKey?: string | null;
      originalFilename?: string;
      contentType?: string;
      sizeBytes?: number;
      safetyCritical?: boolean;
    };
  }>(
    '/admin/documents/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z
          .object({
            title: z.string().min(1).max(200).optional(),
            storageKey: z.string().max(400).optional(),
            thumbnailStorageKey: z.string().max(400).nullable().optional(),
            originalFilename: z.string().max(400).optional(),
            contentType: z.string().max(200).optional(),
            sizeBytes: z.number().int().nonnegative().optional(),
            safetyCritical: z.boolean().optional(),
          })
          .refine((v) => Object.keys(v).length > 0, {
            message: 'At least one field is required.',
          }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
      if (doc.packVersion.status !== 'draft') {
        return reply.badRequest('Cannot edit documents on a published version.');
      }
      const patch: Record<string, unknown> = {};
      const b = request.body;
      if (b.title !== undefined) patch.title = b.title;
      if (b.storageKey !== undefined) patch.storageKey = b.storageKey;
      if (b.thumbnailStorageKey !== undefined)
        patch.thumbnailStorageKey = b.thumbnailStorageKey;
      if (b.originalFilename !== undefined) patch.originalFilename = b.originalFilename;
      if (b.contentType !== undefined) patch.contentType = b.contentType;
      if (b.sizeBytes !== undefined) patch.sizeBytes = b.sizeBytes;
      if (b.safetyCritical !== undefined) patch.safetyCritical = b.safetyCritical;
      const [updated] = await db
        .update(schema.documents)
        .set(patch)
        .where(eq(schema.documents.id, doc.id))
        .returning();
      return updated;
    },
  );

  // Remove a document from a draft version.
  app.delete<{ Params: { id: string } }>(
    '/admin/documents/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: { with: { pack: true } } },
      });
      if (!doc) return reply.notFound();
      requireOrgInScope(scope, doc.packVersion.pack.ownerOrganizationId);
      if (doc.packVersion.status !== 'draft') {
        return reply.badRequest('Cannot remove documents from a published version.');
      }
      await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
      return { ok: true };
    },
  );

  // Delete a content pack version. Allowed if no asset instance currently pins
  // it — a published-but-never-rolled-out version has no live audit trail to
  // protect. The publish audit event is preserved (separate table, not FK).
  app.delete<{ Params: { id: string } }>(
    '/admin/content-pack-versions/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.id),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);
      const pinned = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.pinnedContentPackVersionId, version.id),
      });
      if (pinned) {
        return reply.badRequest(
          'An asset instance pins this version. Unpin it first.',
        );
      }
      await db
        .delete(schema.contentPackVersions)
        .where(eq(schema.contentPackVersions.id, version.id));
      if (version.status === 'published') {
        await db.insert(schema.auditEvents).values({
          organizationId: version.pack.ownerOrganizationId,
          actorUserId: auth.userId,
          eventType: 'content_pack_version.deleted',
          targetType: 'content_pack_version',
          targetId: version.id,
          payload: {
            versionNumber: version.versionNumber,
            versionLabel: version.versionLabel,
            wasPublished: true,
          },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      }
      return { ok: true };
    },
  );

  // Delete a content pack. Allowed if no asset instance pins any version of
  // the pack — same orphan-protection rule as version deletion.
  app.delete<{ Params: { id: string } }>(
    '/admin/content-packs/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const pack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, request.params.id),
      });
      if (!pack) return reply.notFound();
      requireOrgInScope(scope, pack.ownerOrganizationId);
      const versions = await db.query.contentPackVersions.findMany({
        where: eq(schema.contentPackVersions.contentPackId, pack.id),
      });
      if (versions.length > 0) {
        const pinned = await db.query.assetInstances.findFirst({
          where: inArray(
            schema.assetInstances.pinnedContentPackVersionId,
            versions.map((v) => v.id),
          ),
        });
        if (pinned) {
          return reply.badRequest(
            'An asset instance pins a version of this pack. Unpin it first.',
          );
        }
      }
      await db.delete(schema.contentPacks).where(eq(schema.contentPacks.id, pack.id));
      return { ok: true };
    },
  );

  // Publish a draft. Freezes the version; future edits require a new draft.
  // Audit event fired for compliance trail.
  app.post<{ Params: { versionId: string } }>(
    '/admin/content-pack-versions/:versionId/publish',
    { schema: { params: z.object({ versionId: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);

      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: { with: { assetModel: true } } },
      });
      if (!version) return reply.notFound();
      requireOrgInScope(scope, version.pack.ownerOrganizationId);
      if (version.status !== 'draft') {
        return reply.badRequest(`Version is already ${version.status}.`);
      }

      const now = new Date();
      const [updated] = await db
        .update(schema.contentPackVersions)
        .set({ status: 'published', publishedAt: now, publishedBy: auth.userId })
        .where(eq(schema.contentPackVersions.id, version.id))
        .returning();

      await db.insert(schema.auditEvents).values({
        organizationId: version.pack.ownerOrganizationId,
        actorUserId: auth.userId,
        eventType: 'content_pack.published',
        targetType: 'content_pack_version',
        targetId: version.id,
        payload: {
          assetModelId: version.pack.assetModelId,
          versionNumber: version.versionNumber,
          versionLabel: version.versionLabel,
        },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return updated;
    },
  );
}

async function findLatestPublishedVersionId(
  db: import('@platform/db').Database,
  assetModelId: string,
): Promise<string | null> {
  const packs = await db.query.contentPacks.findMany({
    where: and(
      eq(schema.contentPacks.assetModelId, assetModelId),
      eq(schema.contentPacks.layerType, 'base'),
    ),
  });
  if (packs.length === 0) return null;
  const versions = await db.query.contentPackVersions.findMany({
    where: and(
      inArray(
        schema.contentPackVersions.contentPackId,
        packs.map((p) => p.id),
      ),
      eq(schema.contentPackVersions.status, 'published'),
    ),
  });
  if (versions.length === 0) return null;
  versions.sort((a, b) => b.versionNumber - a.versionNumber);
  return versions[0]?.id ?? null;
}

// Additional admin listings — used by the admin app's sidebar pages. All are
// read-only for now; authoring flows come later.
export async function registerAdminListings(app: FastifyInstance) {
  // Dashboard metrics — counts scoped to what the user can see. Platform
  // admins get global counts; everyone else gets counts over their home org
  // and descendants. The predicates mirror how each table ties back to an
  // organization: sites.organization_id directly; asset_instances via site;
  // asset_models / content_packs via owner_organization_id; qr_codes via
  // asset_instance → site; work_orders via asset_instance → site;
  // enrollments via user → home_organization_id.
  app.get('/admin/metrics', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) {
      return {
        organizations: 0,
        sites: 0,
        assetModels: 0,
        assetInstances: 0,
        activeQrCodes: 0,
        openWorkOrders: 0,
        publishedContentPacks: 0,
        enrollments: 0,
        completedEnrollments: 0,
        completionRate: 0,
      };
    }
    const scopeLiteral = orgIdsLiteral(scope);
    const orgFilter = (column: string) =>
      scope.all ? sql`` : sql`WHERE ${sql.raw(column)} = ANY(${scopeLiteral}::uuid[])`;

    const [
      orgs,
      sites,
      models,
      instances,
      activeQr,
      openWorkOrders,
      publishedPacks,
      enrollments,
      completed,
    ] = await Promise.all([
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM organizations`
          : sql`SELECT count(*)::int AS n FROM organizations WHERE id = ANY(${scopeLiteral}::uuid[])`,
      ),
      scalar(
        db,
        sql`SELECT count(*)::int AS n FROM sites ${orgFilter('organization_id')}`,
      ),
      scalar(
        db,
        sql`SELECT count(*)::int AS n FROM asset_models ${orgFilter('owner_organization_id')}`,
      ),
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM asset_instances`
          : sql`SELECT count(*)::int AS n FROM asset_instances ai
                JOIN sites s ON s.id = ai.site_id
                WHERE s.organization_id = ANY(${scopeLiteral}::uuid[])`,
      ),
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM qr_codes WHERE active = true`
          : sql`SELECT count(*)::int AS n FROM qr_codes q
                JOIN asset_instances ai ON ai.id = q.asset_instance_id
                JOIN sites s ON s.id = ai.site_id
                WHERE q.active = true
                  AND s.organization_id = ANY(${scopeLiteral}::uuid[])`,
      ),
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM work_orders
                WHERE status IN ('open','acknowledged','in_progress','blocked')`
          : sql`SELECT count(*)::int AS n FROM work_orders wo
                JOIN asset_instances ai ON ai.id = wo.asset_instance_id
                JOIN sites s ON s.id = ai.site_id
                WHERE wo.status IN ('open','acknowledged','in_progress','blocked')
                  AND s.organization_id = ANY(${scopeLiteral}::uuid[])`,
      ),
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM content_pack_versions WHERE status = 'published'`
          : sql`SELECT count(*)::int AS n FROM content_pack_versions cpv
                JOIN content_packs cp ON cp.id = cpv.content_pack_id
                WHERE cpv.status = 'published'
                  AND cp.owner_organization_id = ANY(${scopeLiteral}::uuid[])`,
      ),
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM enrollments`
          : sql`SELECT count(*)::int AS n FROM enrollments e
                JOIN users u ON u.id = e.user_id
                WHERE u.home_organization_id = ANY(${scopeLiteral}::uuid[])`,
      ),
      scalar(
        db,
        scope.all
          ? sql`SELECT count(*)::int AS n FROM enrollments WHERE status = 'completed'`
          : sql`SELECT count(*)::int AS n FROM enrollments e
                JOIN users u ON u.id = e.user_id
                WHERE e.status = 'completed'
                  AND u.home_organization_id = ANY(${scopeLiteral}::uuid[])`,
      ),
    ]);
    return {
      organizations: orgs,
      sites,
      assetModels: models,
      assetInstances: instances,
      activeQrCodes: activeQr,
      openWorkOrders,
      publishedContentPacks: publishedPacks,
      enrollments,
      completedEnrollments: completed,
      completionRate: enrollments > 0 ? completed / enrollments : 0,
    };
  });

  // Per-tenant setup summary. Powers the SetupStatusCard on the tenant
  // detail page — admin reads this to see "what's left to do for Flow-Turn"
  // without bouncing through 7 separate listing pages. Returns small counts
  // and a couple of name samples for the UI's sub-detail lines.
  //
  // Cost: ~10 indexed counts. All filtered to the single org id; cheap.
  app.get<{ Params: { id: string } }>(
    '/admin/organizations/:id/summary',
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const orgId = request.params.id;
      requireOrgInScope(scope, orgId);

      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, orgId),
      });
      if (!org) return reply.notFound();

      const [
        siteCount,
        assetModelCount,
        partCount,
        bomEntryCount,
        contentPackCount,
        contentPackVersionPublishedCount,
        contentPackVersionDraftCount,
        documentCount,
        trainingModuleCount,
        assetInstanceCount,
        qrCodeCount,
        siteSampleRows,
        assetModelSampleRows,
      ] = await Promise.all([
        scalar(db, sql`SELECT count(*)::int AS n FROM sites WHERE organization_id = ${orgId}`),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM asset_models WHERE owner_organization_id = ${orgId}`,
        ),
        scalar(db, sql`SELECT count(*)::int AS n FROM parts WHERE owner_organization_id = ${orgId}`),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM bom_entries be
              JOIN asset_models m ON m.id = be.asset_model_id
              WHERE m.owner_organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM content_packs WHERE owner_organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM content_pack_versions cpv
              JOIN content_packs cp ON cp.id = cpv.content_pack_id
              WHERE cpv.status = 'published' AND cp.owner_organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM content_pack_versions cpv
              JOIN content_packs cp ON cp.id = cpv.content_pack_id
              WHERE cpv.status = 'draft' AND cp.owner_organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM documents d
              JOIN content_pack_versions cpv ON cpv.id = d.content_pack_version_id
              JOIN content_packs cp ON cp.id = cpv.content_pack_id
              WHERE cp.owner_organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM training_modules tm
              JOIN content_pack_versions cpv ON cpv.id = tm.content_pack_version_id
              JOIN content_packs cp ON cp.id = cpv.content_pack_id
              WHERE cp.owner_organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM asset_instances ai
              JOIN sites s ON s.id = ai.site_id
              WHERE s.organization_id = ${orgId}`,
        ),
        scalar(
          db,
          sql`SELECT count(*)::int AS n FROM qr_codes q
              JOIN asset_instances ai ON ai.id = q.asset_instance_id
              JOIN sites s ON s.id = ai.site_id
              WHERE q.active = true AND s.organization_id = ${orgId}`,
        ),
        db.execute(
          sql`SELECT id, name FROM sites WHERE organization_id = ${orgId} ORDER BY created_at LIMIT 3`,
        ),
        db.execute(
          sql`SELECT id, model_code AS "modelCode", display_name AS "displayName"
              FROM asset_models WHERE owner_organization_id = ${orgId}
              ORDER BY created_at LIMIT 3`,
        ),
      ]);

      return {
        organization: {
          id: org.id,
          name: org.name,
          type: org.type,
          oemCode: org.oemCode,
          createdAt: org.createdAt,
        },
        siteCount,
        siteSample: siteSampleRows as Array<{ id: string; name: string }>,
        assetModelCount,
        assetModelSample: assetModelSampleRows as Array<{
          id: string;
          modelCode: string;
          displayName: string;
        }>,
        partCount,
        bomEntryCount,
        contentPackCount,
        contentPackVersionPublishedCount,
        contentPackVersionDraftCount,
        documentCount,
        trainingModuleCount,
        assetInstanceCount,
        qrCodeCount,
      };
    },
  );

  // Organizations with denormalized counts for the listing page.
  app.get('/admin/organizations', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT o.id, o.type, o.name, o.slug, o.parent_organization_id,
                 o.oem_code, o.created_at,
                 o.brand_primary, o.brand_on_primary, o.logo_storage_key,
                 o.display_name_override, o.require_scan_access, o.msft_tenant_id,
                 p.name AS parent_name,
                 (SELECT count(*) FROM sites WHERE organization_id = o.id)::int AS site_count,
                 (SELECT count(*) FROM users WHERE home_organization_id = o.id)::int AS user_count
          FROM organizations o
          LEFT JOIN organizations p ON p.id = o.parent_organization_id
          ORDER BY o.type, o.name`
        : sql`SELECT o.id, o.type, o.name, o.slug, o.parent_organization_id,
                 o.oem_code, o.created_at,
                 o.brand_primary, o.brand_on_primary, o.logo_storage_key,
                 o.display_name_override, o.require_scan_access, o.msft_tenant_id,
                 p.name AS parent_name,
                 (SELECT count(*) FROM sites WHERE organization_id = o.id)::int AS site_count,
                 (SELECT count(*) FROM users WHERE home_organization_id = o.id)::int AS user_count
          FROM organizations o
          LEFT JOIN organizations p ON p.id = o.parent_organization_id
          WHERE o.id = ANY(${scopeLiteral}::uuid[])
          ORDER BY o.type, o.name`,
    )) as unknown as Array<{
      id: string;
      type: string;
      name: string;
      slug: string;
      parent_organization_id: string | null;
      oem_code: string | null;
      created_at: string;
      brand_primary: string | null;
      brand_on_primary: string | null;
      logo_storage_key: string | null;
      display_name_override: string | null;
      require_scan_access: boolean;
      msft_tenant_id: string | null;
      parent_name: string | null;
      site_count: number;
      user_count: number;
    }>;
    const { storage } = app.ctx;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      slug: r.slug,
      oemCode: r.oem_code,
      parent: r.parent_organization_id
        ? { id: r.parent_organization_id, name: r.parent_name ?? 'Unknown' }
        : null,
      siteCount: r.site_count,
      userCount: r.user_count,
      createdAt: r.created_at,
      requireScanAccess: r.require_scan_access,
      msftTenantId: r.msft_tenant_id,
      brand: {
        primary: r.brand_primary,
        onPrimary: r.brand_on_primary,
        logoStorageKey: r.logo_storage_key,
        logoUrl: r.logo_storage_key ? storage.publicUrl(r.logo_storage_key) : null,
        displayNameOverride: r.display_name_override,
      },
    }));
  });

  // Asset models with instance counts.
  app.get('/admin/asset-models', async (request) => {
    const { db, storage } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT m.id, m.model_code, m.display_name, m.category, m.description,
                 m.image_storage_key,
                 o.id AS owner_id, o.name AS owner_name,
                 (SELECT count(*) FROM asset_instances WHERE asset_model_id = m.id)::int AS instance_count,
                 (SELECT count(*) FROM content_packs WHERE asset_model_id = m.id)::int AS pack_count
          FROM asset_models m
          JOIN organizations o ON o.id = m.owner_organization_id
          ORDER BY m.display_name`
        : sql`SELECT m.id, m.model_code, m.display_name, m.category, m.description,
                 m.image_storage_key,
                 o.id AS owner_id, o.name AS owner_name,
                 (SELECT count(*) FROM asset_instances WHERE asset_model_id = m.id)::int AS instance_count,
                 (SELECT count(*) FROM content_packs WHERE asset_model_id = m.id)::int AS pack_count
          FROM asset_models m
          JOIN organizations o ON o.id = m.owner_organization_id
          WHERE m.owner_organization_id = ANY(${scopeLiteral}::uuid[])
          ORDER BY m.display_name`,
    )) as unknown as Array<{
      id: string;
      model_code: string;
      display_name: string;
      category: string;
      description: string | null;
      image_storage_key: string | null;
      owner_id: string;
      owner_name: string;
      instance_count: number;
      pack_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      modelCode: r.model_code,
      displayName: r.display_name,
      category: r.category,
      description: r.description,
      imageStorageKey: r.image_storage_key,
      imageUrl: r.image_storage_key ? storage.publicUrl(r.image_storage_key) : null,
      owner: { id: r.owner_id, name: r.owner_name },
      instanceCount: r.instance_count,
      packCount: r.pack_count,
    }));
  });

  // Content packs with latest version info.
  app.get('/admin/content-packs', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT p.id, p.name, p.slug, p.layer_type,
                 am.id AS asset_model_id, am.display_name AS asset_model_name,
                 o.name AS owner_name,
                 (SELECT count(*) FROM content_pack_versions WHERE content_pack_id = p.id)::int AS version_count,
                 latest.version_number AS latest_version_number,
                 latest.version_label AS latest_version_label,
                 latest.status AS latest_version_status,
                 latest.published_at AS latest_published_at
          FROM content_packs p
          JOIN asset_models am ON am.id = p.asset_model_id
          JOIN organizations o ON o.id = p.owner_organization_id
          LEFT JOIN LATERAL (
            SELECT version_number, version_label, status, published_at
            FROM content_pack_versions
            WHERE content_pack_id = p.id
            ORDER BY version_number DESC
            LIMIT 1
          ) latest ON true
          ORDER BY p.name`
        : sql`SELECT p.id, p.name, p.slug, p.layer_type,
                 am.id AS asset_model_id, am.display_name AS asset_model_name,
                 o.name AS owner_name,
                 (SELECT count(*) FROM content_pack_versions WHERE content_pack_id = p.id)::int AS version_count,
                 latest.version_number AS latest_version_number,
                 latest.version_label AS latest_version_label,
                 latest.status AS latest_version_status,
                 latest.published_at AS latest_published_at
          FROM content_packs p
          JOIN asset_models am ON am.id = p.asset_model_id
          JOIN organizations o ON o.id = p.owner_organization_id
          LEFT JOIN LATERAL (
            SELECT version_number, version_label, status, published_at
            FROM content_pack_versions
            WHERE content_pack_id = p.id
            ORDER BY version_number DESC
            LIMIT 1
          ) latest ON true
          WHERE p.owner_organization_id = ANY(${scopeLiteral}::uuid[])
          ORDER BY p.name`,
    )) as unknown as Array<{
      id: string;
      name: string;
      slug: string;
      layer_type: string;
      asset_model_id: string;
      asset_model_name: string;
      owner_name: string;
      version_count: number;
      latest_version_number: number | null;
      latest_version_label: string | null;
      latest_version_status: string | null;
      latest_published_at: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      layerType: r.layer_type,
      assetModel: { id: r.asset_model_id, displayName: r.asset_model_name },
      owner: r.owner_name,
      versionCount: r.version_count,
      latestVersion: r.latest_version_number
        ? {
            number: r.latest_version_number,
            label: r.latest_version_label,
            status: r.latest_version_status,
            publishedAt: r.latest_published_at,
          }
        : null,
    }));
  });

  // Content pack detail — all versions and the document manifest per version.
  app.get<{ Params: { id: string } }>(
    '/admin/content-packs/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const pack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, request.params.id),
        with: { assetModel: true },
      });
      if (!pack) return reply.notFound();
      // Scope check: return 404 (not 403) so out-of-scope callers can't
      // confirm the pack exists.
      if (!scope.all && !scope.orgIds.includes(pack.ownerOrganizationId)) {
        return reply.notFound();
      }

      const versions = await db.query.contentPackVersions.findMany({
        where: eq(schema.contentPackVersions.contentPackId, pack.id),
      });
      versions.sort((a, b) => b.versionNumber - a.versionNumber);

      const versionIds = versions.map((v) => v.id);
      const documents = versionIds.length
        ? await db.query.documents.findMany({
            where: inArray(schema.documents.contentPackVersionId, versionIds),
          })
        : [];
      const trainingModules = versionIds.length
        ? await db.query.trainingModules.findMany({
            where: inArray(schema.trainingModules.contentPackVersionId, versionIds),
          })
        : [];

      const byVersion = new Map(
        versions.map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          versionLabel: v.versionLabel,
          status: v.status,
          publishedAt: v.publishedAt,
          changelog: v.changelog,
          documents: [] as Array<{
            id: string;
            title: string;
            kind: string;
            safetyCritical: boolean;
            language: string;
            extractionStatus: string;
            extractionError: string | null;
            extractedAt: string | null;
          }>,
          trainingModules: [] as Array<{ id: string; title: string }>,
        })).map((v) => [v.id, v]),
      );
      for (const d of documents) {
        const v = byVersion.get(d.contentPackVersionId);
        if (v) v.documents.push({
          id: d.id,
          title: d.title,
          kind: d.kind,
          safetyCritical: d.safetyCritical,
          language: d.language,
          extractionStatus: d.extractionStatus,
          extractionError: d.extractionError,
          extractedAt: d.extractedAt ? d.extractedAt.toISOString() : null,
        });
      }
      for (const m of trainingModules) {
        const v = byVersion.get(m.contentPackVersionId);
        if (v) v.trainingModules.push({ id: m.id, title: m.title });
      }

      return {
        id: pack.id,
        name: pack.name,
        slug: pack.slug,
        layerType: pack.layerType,
        assetModel: {
          id: pack.assetModel.id,
          displayName: pack.assetModel.displayName,
          modelCode: pack.assetModel.modelCode,
        },
        versions: [...byVersion.values()].sort((a, b) => b.versionNumber - a.versionNumber),
      };
    },
  );

  // Training modules with module-level enrollment stats. Scoped via the
  // owning content pack's organization.
  app.get('/admin/training-modules', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) return [];
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT tm.id, tm.title, tm.estimated_minutes, tm.pass_threshold,
                 tm.competency_tag,
                 cpv.version_number AS pack_version_number,
                 cp.name AS pack_name,
                 am.display_name AS asset_model_name,
                 (SELECT count(*) FROM enrollments WHERE training_module_id = tm.id)::int AS enrollments,
                 (SELECT count(*) FROM enrollments WHERE training_module_id = tm.id AND status = 'completed')::int AS completed,
                 (SELECT count(*) FROM enrollments WHERE training_module_id = tm.id AND status = 'failed')::int AS failed
          FROM training_modules tm
          JOIN content_pack_versions cpv ON cpv.id = tm.content_pack_version_id
          JOIN content_packs cp ON cp.id = cpv.content_pack_id
          JOIN asset_models am ON am.id = cp.asset_model_id
          ORDER BY tm.title`
        : sql`SELECT tm.id, tm.title, tm.estimated_minutes, tm.pass_threshold,
                 tm.competency_tag,
                 cpv.version_number AS pack_version_number,
                 cp.name AS pack_name,
                 am.display_name AS asset_model_name,
                 (SELECT count(*) FROM enrollments WHERE training_module_id = tm.id)::int AS enrollments,
                 (SELECT count(*) FROM enrollments WHERE training_module_id = tm.id AND status = 'completed')::int AS completed,
                 (SELECT count(*) FROM enrollments WHERE training_module_id = tm.id AND status = 'failed')::int AS failed
          FROM training_modules tm
          JOIN content_pack_versions cpv ON cpv.id = tm.content_pack_version_id
          JOIN content_packs cp ON cp.id = cpv.content_pack_id
          JOIN asset_models am ON am.id = cp.asset_model_id
          WHERE cp.owner_organization_id = ANY(${scopeLiteral}::uuid[])
          ORDER BY tm.title`,
    )) as unknown as Array<{
      id: string;
      title: string;
      estimated_minutes: number | null;
      pass_threshold: number;
      competency_tag: string | null;
      pack_version_number: number;
      pack_name: string;
      asset_model_name: string;
      enrollments: number;
      completed: number;
      failed: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      estimatedMinutes: r.estimated_minutes,
      passThreshold: r.pass_threshold,
      competencyTag: r.competency_tag,
      assetModel: r.asset_model_name,
      contentPack: `${r.pack_name} v${r.pack_version_number}`,
      enrollments: r.enrollments,
      completed: r.completed,
      failed: r.failed,
    }));
  });

  // Parts with BOM membership counts + derived structural role. The role
  // falls out of part_components row counts — no authored field required:
  //   has_children + has_parent → sub_assembly
  //   has_children only        → assembly
  //   has_parent only          → component
  //   neither                  → part   (shown without a badge)
  app.get('/admin/parts', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT p.id, p.oem_part_number, p.display_name, p.description,
                 p.cross_references, p.discontinued, p.image_storage_key,
                 o.name AS owner_name,
                 (SELECT count(*) FROM bom_entries WHERE part_id = p.id)::int AS bom_count,
                 EXISTS(SELECT 1 FROM part_components WHERE parent_part_id = p.id) AS has_children,
                 EXISTS(SELECT 1 FROM part_components WHERE child_part_id = p.id) AS has_parent
          FROM parts p
          JOIN organizations o ON o.id = p.owner_organization_id
          ORDER BY p.display_name`
        : sql`SELECT p.id, p.oem_part_number, p.display_name, p.description,
                 p.cross_references, p.discontinued, p.image_storage_key,
                 o.name AS owner_name,
                 (SELECT count(*) FROM bom_entries WHERE part_id = p.id)::int AS bom_count,
                 EXISTS(SELECT 1 FROM part_components WHERE parent_part_id = p.id) AS has_children,
                 EXISTS(SELECT 1 FROM part_components WHERE child_part_id = p.id) AS has_parent
          FROM parts p
          JOIN organizations o ON o.id = p.owner_organization_id
          WHERE p.owner_organization_id = ANY(${scopeLiteral}::uuid[])
          ORDER BY p.display_name`,
    )) as unknown as Array<{
      id: string;
      oem_part_number: string;
      display_name: string;
      description: string | null;
      cross_references: string[];
      discontinued: boolean;
      image_storage_key: string | null;
      owner_name: string;
      bom_count: number;
      has_children: boolean;
      has_parent: boolean;
    }>;
    const { storage } = app.ctx;
    return rows.map((r) => ({
      id: r.id,
      oemPartNumber: r.oem_part_number,
      displayName: r.display_name,
      description: r.description,
      crossReferences: r.cross_references,
      discontinued: r.discontinued,
      imageStorageKey: r.image_storage_key,
      imageUrl: r.image_storage_key ? storage.publicUrl(r.image_storage_key) : null,
      owner: r.owner_name,
      bomCount: r.bom_count,
      role: deriveRole(r.has_children, r.has_parent),
    }));
  });

  // Users with home org, roles, and membership count.
  app.get('/admin/users', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    const scopeLiteral = orgIdsLiteral(scope);
    const rows = (await db.execute(
      scope.all
        ? sql`SELECT u.id, u.email, u.display_name, u.disabled, u.created_at,
                 o.id AS home_org_id, o.name AS home_org_name,
                 COALESCE(ARRAY_AGG(DISTINCT m.role::text) FILTER (WHERE m.role IS NOT NULL), ARRAY[]::text[]) AS roles,
                 (SELECT count(*) FROM memberships WHERE user_id = u.id)::int AS membership_count
          FROM users u
          JOIN organizations o ON o.id = u.home_organization_id
          LEFT JOIN memberships m ON m.user_id = u.id
          GROUP BY u.id, o.id
          ORDER BY u.display_name`
        : sql`SELECT u.id, u.email, u.display_name, u.disabled, u.created_at,
                 o.id AS home_org_id, o.name AS home_org_name,
                 COALESCE(ARRAY_AGG(DISTINCT m.role::text) FILTER (WHERE m.role IS NOT NULL), ARRAY[]::text[]) AS roles,
                 (SELECT count(*) FROM memberships WHERE user_id = u.id)::int AS membership_count
          FROM users u
          JOIN organizations o ON o.id = u.home_organization_id
          LEFT JOIN memberships m ON m.user_id = u.id
          WHERE u.home_organization_id = ANY(${scopeLiteral}::uuid[])
          GROUP BY u.id, o.id
          ORDER BY u.display_name`,
    )) as unknown as Array<{
      id: string;
      email: string;
      display_name: string;
      disabled: boolean;
      created_at: string;
      home_org_id: string;
      home_org_name: string;
      roles: string[];
      membership_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      disabled: r.disabled,
      homeOrganization: { id: r.home_org_id, name: r.home_org_name },
      roles: r.roles,
      membershipCount: r.membership_count,
      createdAt: r.created_at,
    }));
  });

  // Recent audit events. Limited to last 200 entries within scope.
  app.get('/admin/audit-events', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    const rows = scope.all
      ? await db
          .select()
          .from(schema.auditEvents)
          .orderBy(desc(schema.auditEvents.occurredAt))
          .limit(200)
      : await db
          .select()
          .from(schema.auditEvents)
          .where(inArray(schema.auditEvents.organizationId, scope.orgIds))
          .orderBy(desc(schema.auditEvents.occurredAt))
          .limit(200);

    if (rows.length === 0) return [];

    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const userIds = rows
      .map((r) => r.actorUserId)
      .filter((id): id is string => id !== null);
    const [orgs, users] = await Promise.all([
      db.query.organizations.findMany({ where: inArray(schema.organizations.id, orgIds) }),
      userIds.length
        ? db.query.users.findMany({ where: inArray(schema.users.id, [...new Set(userIds)]) })
        : Promise.resolve([]),
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o.name]));
    const userById = new Map(users.map((u) => [u.id, u.displayName]));

    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      targetType: r.targetType,
      targetId: r.targetId,
      payload: r.payload,
      occurredAt: r.occurredAt,
      organization: orgById.get(r.organizationId) ?? 'Unknown',
      actor: r.actorUserId ? userById.get(r.actorUserId) ?? 'Unknown' : null,
    }));
  });
}

async function scalar(
  db: import('@platform/db').Database,
  query: ReturnType<typeof sql>,
): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
