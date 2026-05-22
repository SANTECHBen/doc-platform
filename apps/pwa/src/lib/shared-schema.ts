import { z } from 'zod';

const UuidSchema = z.string().uuid();

export const AssetHubPayloadSchema = z.object({
  assetInstance: z.object({
    id: UuidSchema,
    serialNumber: z.string(),
    installedAt: z.string().datetime().nullable(),
    imageUrl: z.string().nullable().optional().default(null),
  }),
  assetModel: z.object({
    id: UuidSchema,
    modelCode: z.string(),
    displayName: z.string(),
    category: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
  }),
  site: z.object({
    id: UuidSchema,
    name: z.string(),
    timezone: z.string(),
  }),
  organization: z.object({
    id: UuidSchema,
    name: z.string(),
    requireScanAccess: z.boolean(),
  }),
  pinnedContentPackVersion: z
    .object({
      id: UuidSchema,
      versionNumber: z.number().int(),
      versionLabel: z.string().nullable(),
      publishedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  // Always-draft "Field captures" pack version for this asset model.
  // Null until the first field-procedure capture lazy-creates it. PWA
  // fetches docs from BOTH this and pinnedContentPackVersion.
  fieldCapturesVersionId: UuidSchema.nullable(),
  tabs: z.object({
    docs: z.object({ count: z.number().int() }),
    training: z.object({ count: z.number().int() }),
    parts: z.object({ count: z.number().int() }),
    openWorkOrders: z.object({ count: z.number().int() }),
    // Preventive Maintenance summary computed against the instance's
    // (model schedules, instance service records). overdue + due both
    // count as "needs action now"; soon = due in next 7 days.
    pm: z.object({
      overdue: z.number().int(),
      due: z.number().int(),
      soon: z.number().int(),
      needsAction: z.number().int(),
    }),
  }),
  brand: z.object({
    displayName: z.string(),
    primary: z.string().nullable(),
    onPrimary: z.string().nullable(),
    logoUrl: z.string().nullable(),
    initials: z.string(),
  }),
});

export type AssetHubPayload = z.infer<typeof AssetHubPayloadSchema>;
