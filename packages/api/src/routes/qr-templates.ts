import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@platform/db';
const { DEFAULT_TEMPLATE_FIELDS } = schema;
import { UuidSchema } from '@platform/shared';
import { requireAuth } from '../middleware/auth';
import { getScope, requireOrgInScope } from '../middleware/scope';

// QR label template CRUD. Admin-only; reads and writes are scoped per-org
// the same way as other admin resources. Templates drive the custom
// sticker-design flow on /admin/qr-codes/print.

const FieldToggleWithLabel = z.object({
  enabled: z.boolean(),
  labelOverride: z.string().max(60).nullable(),
});
const FieldToggleWithText = z.object({
  enabled: z.boolean(),
  text: z.string().max(400),
});

const TemplateFieldsSchema = z.object({
  header: FieldToggleWithText,
  model: FieldToggleWithLabel,
  serial: FieldToggleWithLabel,
  site: FieldToggleWithLabel,
  location: FieldToggleWithLabel,
  description: FieldToggleWithText,
  idCode: FieldToggleWithLabel,
});

const LayoutEnum = z.enum(['nameplate', 'minimal', 'safety']);
const ErrorCorrectionEnum = z.enum(['L', 'M', 'Q', 'H']);
const HexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'must be a hex color like #0B5FBF');

export async function registerQrTemplateRoutes(app: FastifyInstance) {
  // List templates in scope. Orders default first, then by name.
  app.get('/admin/qr-label-templates', async (request) => {
    const { db } = app.ctx;
    requireAuth(request);
    const scope = await getScope(request, db);
    if (!scope.all && scope.orgIds.length === 0) return [];

    const rows = await db.query.qrLabelTemplates.findMany({
      where: scope.all
        ? undefined
        : (t, { inArray }) => inArray(t.organizationId, scope.orgIds),
      with: { organization: true },
    });
    rows.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return rows.map((t) => ({
      id: t.id,
      organizationId: t.organizationId,
      organizationName: t.organization.name,
      name: t.name,
      isDefault: t.isDefault,
      layout: t.layout,
      accentColor: t.accentColor,
      logoStorageKey: t.logoStorageKey,
      qrSize: t.qrSize,
      qrErrorCorrection: t.qrErrorCorrection,
      fields: t.fields,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));
  });

  // Fetch a single template for the editor.
  app.get<{ Params: { id: string } }>(
    '/admin/qr-label-templates/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);

      const tpl = await db.query.qrLabelTemplates.findFirst({
        where: eq(schema.qrLabelTemplates.id, request.params.id),
      });
      if (!tpl) return reply.notFound();
      requireOrgInScope(scope, tpl.organizationId);
      return tpl;
    },
  );

  // Create. Default fields payload is applied when not supplied so first-
  // time authors don't have to spell out every toggle.
  app.post<{
    Body: {
      organizationId: string;
      name: string;
      isDefault?: boolean;
      layout?: z.infer<typeof LayoutEnum>;
      accentColor?: string;
      logoStorageKey?: string | null;
      qrSize?: number;
      qrErrorCorrection?: z.infer<typeof ErrorCorrectionEnum>;
      fields?: z.infer<typeof TemplateFieldsSchema>;
    };
  }>(
    '/admin/qr-label-templates',
    {
      schema: {
        body: z.object({
          organizationId: UuidSchema,
          name: z.string().min(1).max(120),
          isDefault: z.boolean().optional(),
          layout: LayoutEnum.optional(),
          accentColor: HexColor.optional(),
          logoStorageKey: z.string().max(400).nullable().optional(),
          qrSize: z.number().int().min(40).max(200).optional(),
          qrErrorCorrection: ErrorCorrectionEnum.optional(),
          fields: TemplateFieldsSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      const auth = requireAuth(request);
      const scope = await getScope(request, db);
      requireOrgInScope(scope, request.body.organizationId);

      const fields = request.body.fields ?? DEFAULT_TEMPLATE_FIELDS;

      // If this template is being marked default, clear the default flag
      // from any sibling template in the same org first. Transactional so
      // we never end up with two defaults mid-request.
      if (request.body.isDefault) {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.qrLabelTemplates)
            .set({ isDefault: false })
            .where(eq(schema.qrLabelTemplates.organizationId, request.body.organizationId));
        });
      }

      const [created] = await db
        .insert(schema.qrLabelTemplates)
        .values({
          organizationId: request.body.organizationId,
          name: request.body.name,
          isDefault: request.body.isDefault ?? false,
          layout: request.body.layout ?? 'nameplate',
          accentColor: request.body.accentColor ?? '#0B5FBF',
          logoStorageKey: request.body.logoStorageKey ?? null,
          qrSize: request.body.qrSize ?? 92,
          qrErrorCorrection: request.body.qrErrorCorrection ?? 'M',
          fields,
          createdByUserId: auth.userId,
        })
        .returning();
      if (!created) return reply.internalServerError();
      return created;
    },
  );

  // Update. All fields optional — the editor sends only what changed.
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      isDefault?: boolean;
      layout?: z.infer<typeof LayoutEnum>;
      accentColor?: string;
      logoStorageKey?: string | null;
      qrSize?: number;
      qrErrorCorrection?: z.infer<typeof ErrorCorrectionEnum>;
      fields?: z.infer<typeof TemplateFieldsSchema>;
    };
  }>(
    '/admin/qr-label-templates/:id',
    {
      schema: {
        params: z.object({ id: UuidSchema }),
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          isDefault: z.boolean().optional(),
          layout: LayoutEnum.optional(),
          accentColor: HexColor.optional(),
          logoStorageKey: z.string().max(400).nullable().optional(),
          qrSize: z.number().int().min(40).max(200).optional(),
          qrErrorCorrection: ErrorCorrectionEnum.optional(),
          fields: TemplateFieldsSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const tpl = await db.query.qrLabelTemplates.findFirst({
        where: eq(schema.qrLabelTemplates.id, request.params.id),
      });
      if (!tpl) return reply.notFound();
      requireOrgInScope(scope, tpl.organizationId);

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      const b = request.body;
      if (b.name !== undefined) patch.name = b.name;
      if (b.layout !== undefined) patch.layout = b.layout;
      if (b.accentColor !== undefined) patch.accentColor = b.accentColor;
      if (b.logoStorageKey !== undefined) patch.logoStorageKey = b.logoStorageKey;
      if (b.qrSize !== undefined) patch.qrSize = b.qrSize;
      if (b.qrErrorCorrection !== undefined) patch.qrErrorCorrection = b.qrErrorCorrection;
      if (b.fields !== undefined) patch.fields = b.fields;

      await db.transaction(async (tx) => {
        if (b.isDefault === true) {
          // Clear sibling defaults in the same org before marking this one.
          await tx
            .update(schema.qrLabelTemplates)
            .set({ isDefault: false })
            .where(
              and(
                eq(schema.qrLabelTemplates.organizationId, tpl.organizationId),
                // No need to exclude the current row — we're about to set it true below.
              ),
            );
          patch.isDefault = true;
        } else if (b.isDefault === false) {
          patch.isDefault = false;
        }
        await tx
          .update(schema.qrLabelTemplates)
          .set(patch)
          .where(eq(schema.qrLabelTemplates.id, tpl.id));
      });

      const updated = await db.query.qrLabelTemplates.findFirst({
        where: eq(schema.qrLabelTemplates.id, tpl.id),
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/qr-label-templates/:id',
    { schema: { params: z.object({ id: UuidSchema }) } },
    async (request, reply) => {
      const { db } = app.ctx;
      requireAuth(request);
      const scope = await getScope(request, db);
      const tpl = await db.query.qrLabelTemplates.findFirst({
        where: eq(schema.qrLabelTemplates.id, request.params.id),
      });
      if (!tpl) return reply.notFound();
      requireOrgInScope(scope, tpl.organizationId);
      await db
        .delete(schema.qrLabelTemplates)
        .where(eq(schema.qrLabelTemplates.id, tpl.id));
      return { ok: true };
    },
  );
}
