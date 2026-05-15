import { z } from 'zod';
import { UuidSchema } from './ids';

// Shape returned by GET /assets/resolve/:qrCode — the contextual hub payload the
// PWA renders when a QR scan lands.
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
    // When true, the PWA requires a valid scan-session cookie (set by /q/:code)
    // to show asset content. Lets security-sensitive customers block URL-sharing
    // leakage without requiring login.
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
  // The always-draft "Field captures" pack's version for this asset model,
  // when one exists. The PWA fetches docs from BOTH this and the pinned
  // version above so field-authored procedures show up alongside OEM
  // content. Lazy-created on the first field-procedure capture.
  fieldCapturesVersionId: UuidSchema.nullable(),
  // Compact tabs summary for the hub UI.
  tabs: z.object({
    docs: z.object({ count: z.number().int() }),
    training: z.object({ count: z.number().int() }),
    parts: z.object({ count: z.number().int() }),
    openWorkOrders: z.object({ count: z.number().int() }),
    // Preventive Maintenance summary computed against the instance's
    // (model schedules, instance service records). overdue+due both
    // count as "needs action now"; soon = due in next 7 days.
    pm: z.object({
      overdue: z.number().int(),
      due: z.number().int(),
      soon: z.number().int(),
      needsAction: z.number().int(),
    }),
  }),
  // Branding resolved from the asset model's owning OEM. Technicians see the
  // OEM's identity, not ours.
  brand: z.object({
    displayName: z.string(),
    primary: z.string().nullable(),       // hex, e.g. "#F77531"
    onPrimary: z.string().nullable(),     // hex, text on primary
    logoUrl: z.string().nullable(),       // served via /files/<key>
    initials: z.string(),                 // fallback when no logo uploaded
  }),
});

export type AssetHubPayload = z.infer<typeof AssetHubPayloadSchema>;
