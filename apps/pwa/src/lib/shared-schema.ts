import { z } from 'zod';

const UuidSchema = z.string().uuid();

export const AssetHubPayloadSchema = z.object({
  assetInstance: z.object({
    id: UuidSchema,
    serialNumber: z.string(),
    installedAt: z.string().datetime().nullable(),
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
  tabs: z.object({
    docs: z.object({ count: z.number().int() }),
    training: z.object({ count: z.number().int() }),
    parts: z.object({ count: z.number().int() }),
    openWorkOrders: z.object({ count: z.number().int() }),
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
