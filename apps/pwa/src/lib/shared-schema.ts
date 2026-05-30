import { z } from 'zod';

const UuidSchema = z.string().uuid();

// Mirrors AssetModelSpecsSchema in @platform/shared. Keep in sync.
const AssetModelSpecsSchema = z.object({
  conveyor: z.string().nullable().optional(),
  length: z.string().nullable().optional(),
  flowRate: z.string().nullable().optional(),
  speed: z.string().nullable().optional(),
});

export const AssetHubPayloadSchema = z.object({
  assetInstance: z.object({
    id: UuidSchema,
    serialNumber: z.string(),
    installedAt: z.string().datetime().nullable(),
    imageUrl: z.string().nullable().optional().default(null),
    // Per-install location (e.g. "Columns: B-C/23.5-23"). Stored on
    // assetInstances.metadata.location and authored from the admin
    // instance Edit drawer.
    location: z.string().nullable().optional().default(null),
    // Optional per-install Equipment Part Number. Stored on
    // assetInstances.metadata.epn.
    epn: z.string().nullable().optional().default(null),
  }),
  assetModel: z.object({
    id: UuidSchema,
    modelCode: z.string(),
    displayName: z.string(),
    category: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    // Engineering specs lifted off the OEM drawing — model SKU level.
    // Authored from the admin asset model Edit drawer.
    specifications: AssetModelSpecsSchema.optional().default({}),
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
