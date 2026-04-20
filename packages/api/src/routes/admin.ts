import type { FastifyInstance } from 'fastify';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { schema } from '@platform/db';
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';

export async function registerAdminRoutes(app: FastifyInstance) {
  // List asset instances with model + site info (for the sticker picker).
  // Phase 1: returns everything the caller can see; real auth scoping is a
  // WorkOS-wiring task.
  app.get('/admin/asset-instances', async () => {
    const { db } = app.ctx;
    const rows = await db.query.assetInstances.findMany({
      with: {
        model: true,
        site: { with: { organization: true } },
      },
    });
    return rows
      .map((r) => ({
        id: r.id,
        serialNumber: r.serialNumber,
        assetModel: {
          id: r.model.id,
          modelCode: r.model.modelCode,
          displayName: r.model.displayName,
          category: r.model.category,
        },
        site: { id: r.site.id, name: r.site.name },
        organization: { id: r.site.organization.id, name: r.site.organization.name },
      }))
      .sort((a, b) => a.assetModel.displayName.localeCompare(b.assetModel.displayName));
  });

  // List QR codes with resolved asset instance.
  app.get('/admin/qr-codes', async () => {
    const { db } = app.ctx;
    const codes = await db
      .select()
      .from(schema.qrCodes)
      .orderBy(desc(schema.qrCodes.createdAt));
    if (codes.length === 0) return [];

    const instanceIds = codes
      .map((c) => c.assetInstanceId)
      .filter((id): id is string => id !== null);
    const instances = instanceIds.length
      ? await db.query.assetInstances.findMany({
          where: inArray(schema.assetInstances.id, instanceIds),
          with: { model: true, site: true },
        })
      : [];
    const byId = new Map(instances.map((i) => [i.id, i]));

    return codes.map((c) => {
      const instance = c.assetInstanceId ? byId.get(c.assetInstanceId) : null;
      return {
        id: c.id,
        code: c.code,
        label: c.label,
        active: c.active,
        createdAt: c.createdAt,
        assetInstance: instance
          ? {
              id: instance.id,
              serialNumber: instance.serialNumber,
              modelDisplayName: instance.model.displayName,
              modelCategory: instance.model.category,
              siteName: instance.site.name,
            }
          : null,
      };
    });
  });

  // Mint a new QR code for an asset instance.
  app.post<{ Body: { assetInstanceId: string; label?: string } }>(
    '/admin/qr-codes',
    {
      schema: {
        body: z.object({
          assetInstanceId: UuidSchema,
          label: z.string().max(120).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);

      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.body.assetInstanceId),
      });
      if (!instance) return reply.notFound('Asset instance not found.');

      const code = generateQrCode();
      const [created] = await db
        .insert(schema.qrCodes)
        .values({
          code,
          assetInstanceId: instance.id,
          label: request.body.label ?? null,
          active: true,
        })
        .returning();
      if (!created) return reply.internalServerError('Failed to mint QR code.');
      return created;
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
      requireAuth(request);

      // Non-OEM orgs should declare a parent in the tenancy chain.
      if (request.body.type !== 'oem' && !request.body.parentOrganizationId) {
        return reply.badRequest(
          'Non-OEM organizations must specify a parent organization.',
        );
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
      const instance = await db.query.assetInstances.findFirst({
        where: eq(schema.assetInstances.id, request.params.id),
      });
      if (!instance) return reply.notFound();
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

  // All sites across all orgs (for the asset-instance site picker — the
  // onboarding flow usually assigns Flow Turn conveyors to an Amazon DC, which
  // is a different org than Flow Turn itself).
  app.get('/admin/sites', async () => {
    const { db } = app.ctx;
    const rows = await db.query.sites.findMany({
      with: { organization: true },
    });
    return rows
      .map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        organizationId: s.organizationId,
        organizationName: s.organization.name,
        organizationType: s.organization.type,
      }))
      .sort((a, b) =>
        `${a.organizationName} ${a.name}`.localeCompare(
          `${b.organizationName} ${b.name}`,
        ),
      );
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
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
      });
      if (!version) return reply.notFound();
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

  // List all parts owned by a given OEM — for the BOM picker on asset models.
  app.get<{ Querystring: { ownerId?: string } }>(
    '/admin/parts/by-owner',
    { schema: { querystring: z.object({ ownerId: UuidSchema.optional() }) } },
    async (request) => {
      const { db, storage } = app.ctx;
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
      await db.delete(schema.bomEntries).where(eq(schema.bomEntries.id, request.params.id));
      return { ok: true };
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
      rows.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
      return rows.map((w) => ({
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
  app.post('/admin/uploads', async (request, reply) => {
    const { storage } = app.ctx;
    requireAuth(request);

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

      const assetModel = await db.query.assetModels.findFirst({
        where: eq(schema.assetModels.id, request.body.assetModelId),
      });
      if (!assetModel) return reply.badRequest('Asset model not found.');
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

      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
      });
      if (!version) return reply.notFound();
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
        })
        .returning();
      return doc;
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
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: true },
      });
      if (!doc) return reply.notFound();
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
      const doc = await db.query.documents.findFirst({
        where: eq(schema.documents.id, request.params.id),
        with: { packVersion: true },
      });
      if (!doc) return reply.notFound();
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
      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.id),
        with: { pack: true },
      });
      if (!version) return reply.notFound();
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
      const pack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, request.params.id),
      });
      if (!pack) return reply.notFound();
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

      const version = await db.query.contentPackVersions.findFirst({
        where: eq(schema.contentPackVersions.id, request.params.versionId),
        with: { pack: { with: { assetModel: true } } },
      });
      if (!version) return reply.notFound();
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
  // Dashboard metrics — a small grab-bag of counts and signal numbers.
  app.get('/admin/metrics', async () => {
    const { db } = app.ctx;
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
      scalar(db, sql`SELECT count(*)::int AS n FROM organizations`),
      scalar(db, sql`SELECT count(*)::int AS n FROM sites`),
      scalar(db, sql`SELECT count(*)::int AS n FROM asset_models`),
      scalar(db, sql`SELECT count(*)::int AS n FROM asset_instances`),
      scalar(db, sql`SELECT count(*)::int AS n FROM qr_codes WHERE active = true`),
      scalar(
        db,
        sql`SELECT count(*)::int AS n FROM work_orders
            WHERE status IN ('open','acknowledged','in_progress','blocked')`,
      ),
      scalar(
        db,
        sql`SELECT count(*)::int AS n FROM content_pack_versions WHERE status = 'published'`,
      ),
      scalar(db, sql`SELECT count(*)::int AS n FROM enrollments`),
      scalar(
        db,
        sql`SELECT count(*)::int AS n FROM enrollments WHERE status = 'completed'`,
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

  // Organizations with denormalized counts for the listing page.
  app.get('/admin/organizations', async () => {
    const { db } = app.ctx;
    const rows = (await db.execute(
      sql`SELECT o.id, o.type, o.name, o.slug, o.parent_organization_id,
                 o.oem_code, o.created_at,
                 o.brand_primary, o.brand_on_primary, o.logo_storage_key,
                 o.display_name_override,
                 p.name AS parent_name,
                 (SELECT count(*) FROM sites WHERE organization_id = o.id)::int AS site_count,
                 (SELECT count(*) FROM users WHERE home_organization_id = o.id)::int AS user_count
          FROM organizations o
          LEFT JOIN organizations p ON p.id = o.parent_organization_id
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
  app.get('/admin/asset-models', async () => {
    const { db, storage } = app.ctx;
    const rows = (await db.execute(
      sql`SELECT m.id, m.model_code, m.display_name, m.category, m.description,
                 m.image_storage_key,
                 o.id AS owner_id, o.name AS owner_name,
                 (SELECT count(*) FROM asset_instances WHERE asset_model_id = m.id)::int AS instance_count,
                 (SELECT count(*) FROM content_packs WHERE asset_model_id = m.id)::int AS pack_count
          FROM asset_models m
          JOIN organizations o ON o.id = m.owner_organization_id
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
  app.get('/admin/content-packs', async () => {
    const { db } = app.ctx;
    const rows = (await db.execute(
      sql`SELECT p.id, p.name, p.slug, p.layer_type,
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
      const pack = await db.query.contentPacks.findFirst({
        where: eq(schema.contentPacks.id, request.params.id),
        with: { assetModel: true },
      });
      if (!pack) return reply.notFound();

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

  // Training modules with module-level enrollment stats.
  app.get('/admin/training-modules', async () => {
    const { db } = app.ctx;
    const rows = (await db.execute(
      sql`SELECT tm.id, tm.title, tm.estimated_minutes, tm.pass_threshold,
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

  // Parts with BOM membership counts.
  app.get('/admin/parts', async () => {
    const { db } = app.ctx;
    const rows = (await db.execute(
      sql`SELECT p.id, p.oem_part_number, p.display_name, p.description,
                 p.cross_references, p.discontinued, p.image_storage_key,
                 o.name AS owner_name,
                 (SELECT count(*) FROM bom_entries WHERE part_id = p.id)::int AS bom_count
          FROM parts p
          JOIN organizations o ON o.id = p.owner_organization_id
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
    }));
  });

  // Users with home org, roles, and membership count.
  app.get('/admin/users', async () => {
    const { db } = app.ctx;
    const rows = (await db.execute(
      sql`SELECT u.id, u.email, u.display_name, u.disabled, u.created_at,
                 o.id AS home_org_id, o.name AS home_org_name,
                 COALESCE(ARRAY_AGG(DISTINCT m.role) FILTER (WHERE m.role IS NOT NULL), ARRAY[]::text[]) AS roles,
                 (SELECT count(*) FROM memberships WHERE user_id = u.id)::int AS membership_count
          FROM users u
          JOIN organizations o ON o.id = u.home_organization_id
          LEFT JOIN memberships m ON m.user_id = u.id
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

  // Recent audit events. Limited to last 200 entries.
  app.get('/admin/audit-events', async () => {
    const { db } = app.ctx;
    const rows = await db
      .select()
      .from(schema.auditEvents)
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
