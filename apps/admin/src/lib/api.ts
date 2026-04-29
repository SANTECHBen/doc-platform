const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

// Pulls the current user's Microsoft ID token from the NextAuth session
// cookie (server-set) via the /api/auth/session endpoint. The ID token is
// a JWT signed by Microsoft — our API validates the signature against MS's
// JWKS. If the session endpoint is missing the token (user not signed in),
// the request will 401 at the API layer.
//
// We deliberately don't cache client-side: NextAuth's jwt callback
// transparently refreshes the underlying MS tokens when they near expiry,
// so the session endpoint always returns the current valid ID token. A
// fetch-per-call here keeps us aligned with whatever the server produced,
// including post-refresh rotations. The call is cheap (cookie read + JSON).
async function authHeaders(): Promise<Record<string, string>> {
  if (typeof window === 'undefined') return {};
  try {
    const res = await fetch('/api/auth/session', { cache: 'no-store' });
    if (res.ok) {
      const session = (await res.json()) as { idToken?: string } | null;
      if (session?.idToken) {
        return { authorization: `Bearer ${session.idToken}` };
      }
    }
  } catch {
    // Network failure — fall through unauthenticated; API will 401.
  }
  return {};
}

export const PUBLIC_PWA_ORIGIN =
  process.env.NEXT_PUBLIC_PWA_ORIGIN ?? 'http://localhost:3000';

export interface AdminAssetInstance {
  id: string;
  serialNumber: string;
  assetModel: {
    id: string;
    modelCode: string;
    displayName: string;
    category: string;
  };
  site: { id: string; name: string };
  organization: { id: string; name: string };
}

export interface AdminQrCode {
  id: string;
  code: string;
  label: string | null;
  active: boolean;
  createdAt: string;
  preferredTemplate: { id: string; name: string } | null;
  assetInstance: {
    id: string;
    serialNumber: string;
    modelDisplayName: string;
    modelCategory: string;
    siteName: string;
  } | null;
}

export async function listAssetInstances(): Promise<AdminAssetInstance[]> {
  const res = await fetch(`${API_BASE}/admin/asset-instances`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminAssetInstance[];
}

export async function listQrCodes(): Promise<AdminQrCode[]> {
  const res = await fetch(`${API_BASE}/admin/qr-codes`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrCode[];
}

export interface AdminMetrics {
  organizations: number;
  sites: number;
  assetModels: number;
  assetInstances: number;
  activeQrCodes: number;
  openWorkOrders: number;
  publishedContentPacks: number;
  enrollments: number;
  completedEnrollments: number;
  completionRate: number;
}

export async function getMetrics(): Promise<AdminMetrics> {
  const res = await fetch(`${API_BASE}/admin/metrics`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminMetrics;
}

// Per-tenant setup summary — backs the SetupStatusCard on the tenant
// detail page. Mirrors the shape returned by GET /admin/organizations/:id/summary.
export interface OrganizationSummary {
  organization: {
    id: string;
    name: string;
    type: 'oem' | 'dealer' | 'integrator' | 'end_customer';
    oemCode: string | null;
    createdAt: string;
  };
  siteCount: number;
  siteSample: Array<{ id: string; name: string }>;
  assetModelCount: number;
  assetModelSample: Array<{ id: string; modelCode: string; displayName: string }>;
  partCount: number;
  bomEntryCount: number;
  contentPackCount: number;
  contentPackVersionPublishedCount: number;
  contentPackVersionDraftCount: number;
  documentCount: number;
  trainingModuleCount: number;
  assetInstanceCount: number;
  qrCodeCount: number;
}

export async function getOrganizationSummary(id: string): Promise<OrganizationSummary> {
  const res = await fetch(
    `${API_BASE}/admin/organizations/${encodeURIComponent(id)}/summary`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as OrganizationSummary;
}

export interface AdminOrganization {
  id: string;
  type: 'oem' | 'dealer' | 'integrator' | 'end_customer';
  name: string;
  slug: string;
  oemCode: string | null;
  parent: { id: string; name: string } | null;
  siteCount: number;
  userCount: number;
  createdAt: string;
  requireScanAccess: boolean;
  msftTenantId: string | null;
  brand: {
    primary: string | null;
    onPrimary: string | null;
    logoStorageKey: string | null;
    logoUrl: string | null;
    displayNameOverride: string | null;
  };
}

export async function updateOrgPrivacy(
  id: string,
  body: {
    requireScanAccess?: boolean;
    /** Microsoft tenant UUID, or null to unlink the org from any tenant. */
    msftTenantId?: string | null;
  },
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/organizations/${encodeURIComponent(id)}/privacy`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function updateOrgBranding(
  id: string,
  body: {
    brandPrimary?: string | null;
    brandOnPrimary?: string | null;
    logoStorageKey?: string | null;
    displayNameOverride?: string | null;
  },
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/organizations/${encodeURIComponent(id)}/branding`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function listOrganizations(): Promise<AdminOrganization[]> {
  const res = await fetch(`${API_BASE}/admin/organizations`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminOrganization[];
}

export interface AdminAssetModel {
  id: string;
  modelCode: string;
  displayName: string;
  category: string;
  description: string | null;
  imageStorageKey: string | null;
  imageUrl: string | null;
  owner: { id: string; name: string };
  instanceCount: number;
  packCount: number;
}

export async function updateAssetModelImage(
  id: string,
  imageStorageKey: string | null,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(id)}/image`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ imageStorageKey }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function listAdminAssetModels(): Promise<AdminAssetModel[]> {
  const res = await fetch(`${API_BASE}/admin/asset-models`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminAssetModel[];
}

export interface AdminContentPack {
  id: string;
  name: string;
  slug: string;
  layerType: 'base' | 'dealer_overlay' | 'site_overlay';
  assetModel: { id: string; displayName: string };
  owner: string;
  versionCount: number;
  latestVersion: {
    number: number;
    label: string | null;
    status: string;
    publishedAt: string | null;
  } | null;
}

export async function listContentPacks(): Promise<AdminContentPack[]> {
  const res = await fetch(`${API_BASE}/admin/content-packs`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminContentPack[];
}

export interface AdminContentPackDetail {
  id: string;
  name: string;
  slug: string;
  layerType: string;
  assetModel: { id: string; displayName: string; modelCode: string };
  versions: Array<{
    id: string;
    versionNumber: number;
    versionLabel: string | null;
    status: string;
    publishedAt: string | null;
    changelog: string | null;
    documents: Array<{
      id: string;
      title: string;
      kind: string;
      safetyCritical: boolean;
      language: string;
      extractionStatus:
        | 'not_applicable'
        | 'pending'
        | 'processing'
        | 'ready'
        | 'failed';
      extractionError: string | null;
      extractedAt: string | null;
    }>;
    trainingModules: Array<{ id: string; title: string }>;
  }>;
}

export async function getContentPack(id: string): Promise<AdminContentPackDetail | null> {
  const res = await fetch(`${API_BASE}/admin/content-packs/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminContentPackDetail;
}

/** Re-run extraction + chunking + embedding for a document. */
export async function reprocessDocument(documentId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/reprocess`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export interface AdminTrainingModule {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  passThreshold: number;
  competencyTag: string | null;
  assetModel: string;
  contentPack: string;
  enrollments: number;
  completed: number;
  failed: number;
}

export async function listAdminTrainingModules(): Promise<AdminTrainingModule[]> {
  const res = await fetch(`${API_BASE}/admin/training-modules`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminTrainingModule[];
}

export type PartRole = 'part' | 'assembly' | 'component' | 'sub_assembly';

export interface AdminPart {
  id: string;
  oemPartNumber: string;
  displayName: string;
  description: string | null;
  crossReferences: string[];
  discontinued: boolean;
  imageStorageKey: string | null;
  imageUrl: string | null;
  owner: string;
  bomCount: number;
  role: PartRole;
}

export async function updatePartImage(
  id: string,
  imageStorageKey: string | null,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/parts/${encodeURIComponent(id)}/image`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ imageStorageKey }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function listAdminParts(): Promise<AdminPart[]> {
  const res = await fetch(`${API_BASE}/admin/parts`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminPart[];
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  disabled: boolean;
  homeOrganization: { id: string; name: string };
  roles: string[];
  membershipCount: number;
  createdAt: string;
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const res = await fetch(`${API_BASE}/admin/users`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminUser[];
}

export interface AdminAuditEvent {
  id: string;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  organization: string;
  actor: string | null;
}

export async function listAuditEvents(): Promise<AdminAuditEvent[]> {
  const res = await fetch(`${API_BASE}/admin/audit-events`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminAuditEvent[];
}

export async function createOrganization(params: {
  type: 'oem' | 'dealer' | 'integrator' | 'end_customer';
  name: string;
  slug: string;
  parentOrganizationId?: string;
  oemCode?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/admin/organizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export async function createSite(params: {
  organizationId: string;
  name: string;
  code?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  timezone?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/admin/sites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export async function createAssetModel(params: {
  ownerOrganizationId: string;
  modelCode: string;
  displayName: string;
  category: string;
  description?: string;
  imageStorageKey?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/admin/asset-models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export async function createAssetInstance(params: {
  assetModelId: string;
  siteId: string;
  serialNumber: string;
  installedAt?: string;
  pinnedContentPackVersionId?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/admin/asset-instances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

export async function pinLatestVersion(instanceId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/asset-instances/${instanceId}/pin-latest`,
    { method: 'POST', headers: { ...(await authHeaders()) } },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function unpinInstance(instanceId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/asset-instances/${instanceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ pinnedContentPackVersionId: null }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export interface BulkInstanceResult {
  attempted: number;
  created: number;
  skipped: number;
  instances: Array<{ id: string; serialNumber: string }>;
}

export async function bulkCreateAssetInstances(params: {
  assetModelId: string;
  siteId: string;
  serialNumbers: string[];
  installedAt?: string;
  pinnedContentPackVersionId?: string;
}): Promise<BulkInstanceResult> {
  const res = await fetch(`${API_BASE}/admin/asset-instances/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as BulkInstanceResult;
}

export interface AdminSite {
  id: string;
  name: string;
  code: string | null;
  organizationId: string;
  organizationName: string;
  organizationType: string;
}

export interface UploadResult {
  storageKey: string;
  sha256: string;
  size: number;
  contentType: string;
  originalFilename: string;
  url: string;
}

export async function uploadFile(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadResult> {
  // Use XHR so we can surface progress during large video uploads. The fetch
  // API does not expose an upload progress event.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/admin/uploads`, true);
    for (const [k, v] of Object.entries(authHeaders())) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`${xhr.status}: ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export async function createContentPack(params: {
  assetModelId: string;
  name: string;
  slug: string;
  layerType: 'base' | 'dealer_overlay' | 'site_overlay';
  basePackId?: string;
}): Promise<{
  pack: { id: string; name: string; slug: string };
  version: { id: string; versionNumber: number; versionLabel: string | null } | null;
}> {
  const res = await fetch(`${API_BASE}/admin/content-packs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ createDraftVersion: true, ...params }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createContentPackVersion(
  packId: string,
  body: { versionLabel?: string; changelog?: string } = {},
): Promise<{ id: string; versionNumber: number; versionLabel: string | null; status: string }> {
  const res = await fetch(
    `${API_BASE}/admin/content-packs/${encodeURIComponent(packId)}/versions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export type DocumentKind =
  | 'markdown'
  | 'pdf'
  | 'video'
  | 'structured_procedure'
  | 'schematic'
  | 'slides'
  | 'file'
  | 'external_video';

export interface CreateDocumentInput {
  kind: DocumentKind;
  title: string;
  language?: string;
  safetyCritical?: boolean;
  tags?: string[];
  bodyMarkdown?: string;
  storageKey?: string;
  thumbnailStorageKey?: string;
  externalUrl?: string;
  streamPlaybackId?: string;
  originalFilename?: string;
  contentType?: string;
  sizeBytes?: number;
  orderingHint?: number;
}

export async function createDocument(
  versionId: string,
  body: CreateDocumentInput,
): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/content-pack-versions/${encodeURIComponent(versionId)}/documents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function deleteContentPack(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/content-packs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function deleteContentPackVersion(versionId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/content-pack-versions/${encodeURIComponent(versionId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function updateDocument(
  id: string,
  patch: {
    title?: string;
    storageKey?: string;
    thumbnailStorageKey?: string | null;
    originalFilename?: string;
    contentType?: string;
    sizeBytes?: number;
    safetyCritical?: boolean;
  },
): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// --- Training authoring ---------------------------------------------------
export async function createTrainingModule(params: {
  contentPackVersionId: string;
  title: string;
  description?: string;
  estimatedMinutes?: number;
  competencyTag?: string;
  passThreshold?: number;
}): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/content-pack-versions/${encodeURIComponent(params.contentPackVersionId)}/training-modules`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(params),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createLesson(
  moduleId: string,
  body: { title: string; bodyMarkdown?: string },
): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(moduleId)}/lessons`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export interface AdminLesson {
  id: string;
  trainingModuleId: string;
  title: string;
  bodyMarkdown: string | null;
  streamPlaybackId: string | null;
  orderingHint: number;
}

export interface AdminQuizQuestion {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
}

export interface AdminActivity {
  id: string;
  trainingModuleId: string;
  kind: 'quiz' | 'checklist' | 'procedure_signoff' | 'video_knowledge_check' | 'practical';
  title: string;
  config: { questions?: AdminQuizQuestion[] } & Record<string, unknown>;
  weight: number;
  orderingHint: number;
}

export interface AdminTrainingModuleDetail {
  id: string;
  title: string;
  description: string | null;
  estimatedMinutes: number | null;
  competencyTag: string | null;
  passThreshold: number;
  orderingHint: number;
  contentPack: {
    id: string;
    name: string;
    versionNumber: number;
    versionLabel: string | null;
    status: 'draft' | 'in_review' | 'published' | 'archived';
  };
  lessons: AdminLesson[];
  activities: AdminActivity[];
}

export async function getTrainingModule(id: string): Promise<AdminTrainingModuleDetail | null> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(id)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateTrainingModule(
  id: string,
  body: Partial<{
    title: string;
    description: string | null;
    estimatedMinutes: number | null;
    competencyTag: string | null;
    passThreshold: number;
    orderingHint: number;
  }>,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function deleteTrainingModule(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function updateLesson(
  id: string,
  body: Partial<{ title: string; bodyMarkdown: string | null; orderingHint: number }>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/lessons/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function deleteLesson(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/lessons/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function createQuizActivity(
  moduleId: string,
  body: {
    title: string;
    questions: AdminQuizQuestion[];
  },
): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(moduleId)}/quiz-activities`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateActivity(
  id: string,
  body: Partial<{
    title: string;
    questions: AdminQuizQuestion[];
    weight: number;
    orderingHint: number;
  }>,
): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/activities/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function deleteActivity(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/activities/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// --- Parts authoring + BOM ------------------------------------------------
export async function createPart(params: {
  ownerOrganizationId: string;
  oemPartNumber: string;
  displayName: string;
  description?: string;
  crossReferences?: string[];
  imageStorageKey?: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/admin/parts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function listPartsByOwner(ownerId: string): Promise<Array<{
  id: string;
  oemPartNumber: string;
  displayName: string;
  description: string | null;
  imageUrl: string | null;
}>> {
  const res = await fetch(
    `${API_BASE}/admin/parts/by-owner?ownerId=${encodeURIComponent(ownerId)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export interface BomEntry {
  bomEntryId: string;
  partId: string;
  positionRef: string | null;
  quantity: number;
  notes: string | null;
  oemPartNumber: string | null;
  displayName: string;
  imageUrl: string | null;
}

export async function listBom(modelId: string): Promise<BomEntry[]> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/bom`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function addBomEntry(
  modelId: string,
  body: { partId: string; positionRef?: string; quantity: number; notes?: string },
): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/bom`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function removeBomEntry(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/bom-entries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// --- Part components (parent → children hierarchy) -----------------------

export interface PartComponent {
  linkId: string;
  childPartId: string;
  oemPartNumber: string;
  displayName: string;
  description: string | null;
  positionRef: string | null;
  quantity: number;
  notes: string | null;
  orderingHint: number;
  imageUrl: string | null;
}

export async function listPartComponents(partId: string): Promise<PartComponent[]> {
  const res = await fetch(
    `${API_BASE}/admin/parts/${encodeURIComponent(partId)}/components`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function addPartComponent(
  partId: string,
  body: {
    childPartId: string;
    positionRef?: string;
    quantity: number;
    notes?: string;
    orderingHint?: number;
  },
): Promise<{ id: string }> {
  const res = await fetch(
    `${API_BASE}/admin/parts/${encodeURIComponent(partId)}/components`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function removePartComponent(linkId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/part-components/${encodeURIComponent(linkId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// --- Part ↔ Document / TrainingModule linking -----------------------------

export interface LinkedPart {
  linkId: string;
  partId: string;
  oemPartNumber: string;
  displayName: string;
}

export async function listPartsForDocument(documentId: string): Promise<LinkedPart[]> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/parts`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function setPartsForDocument(
  documentId: string,
  partIds: string[],
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/parts`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ partIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function listPartsForTrainingModule(moduleId: string): Promise<LinkedPart[]> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(moduleId)}/parts`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function setPartsForTrainingModule(
  moduleId: string,
  partIds: string[],
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/training-modules/${encodeURIComponent(moduleId)}/parts`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ partIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// --- Work orders ----------------------------------------------------------
export interface AdminWorkOrder {
  id: string;
  title: string;
  description: string | null;
  status: 'open' | 'acknowledged' | 'in_progress' | 'blocked' | 'resolved' | 'closed';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  openedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  attachments: Array<{ key: string; mime: string; caption?: string }>;
  assetInstance: {
    id: string;
    serialNumber: string;
    modelDisplayName: string;
    modelCode: string;
    siteName: string;
    organizationName: string;
  };
  openedBy: { id: string; displayName: string } | null;
  assignedTo: { id: string; displayName: string } | null;
}

export async function listAdminWorkOrders(
  status: 'open' | 'closed' | 'all' = 'open',
): Promise<AdminWorkOrder[]> {
  const res = await fetch(`${API_BASE}/admin/work-orders?status=${status}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateWorkOrder(
  id: string,
  body: { status?: AdminWorkOrder['status']; assignedToUserId?: string | null },
): Promise<void> {
  const res = await fetch(`${API_BASE}/work-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function publishContentPackVersion(
  versionId: string,
): Promise<{ id: string; status: string; publishedAt: string }> {
  const res = await fetch(
    `${API_BASE}/admin/content-pack-versions/${encodeURIComponent(versionId)}/publish`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function listAllSites(): Promise<AdminSite[]> {
  const res = await fetch(`${API_BASE}/admin/sites`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSite[];
}

export async function listSitesForOrg(orgId: string): Promise<Array<{
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string;
}>> {
  const res = await fetch(
    `${API_BASE}/admin/organizations/${encodeURIComponent(orgId)}/sites`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export interface ModelInstance {
  id: string;
  serialNumber: string;
  installedAt: string | null;
  site: { id: string; name: string; organization: string };
  pinnedVersion: { id: string; number: number; label: string | null } | null;
}

export async function listInstancesForModel(modelId: string): Promise<ModelInstance[]> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/instances`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function mintQrCode(params: {
  assetInstanceId: string;
  label?: string;
  preferredTemplateId?: string | null;
}): Promise<AdminQrCode> {
  const res = await fetch(`${API_BASE}/admin/qr-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as {
    id: string;
    code: string;
    label: string | null;
    active: boolean;
    createdAt: string;
    assetInstanceId: string | null;
  };
  return {
    id: raw.id,
    code: raw.code,
    label: raw.label,
    active: raw.active,
    createdAt: raw.createdAt,
    preferredTemplate: null,
    assetInstance: null,
  };
}

export async function updateQrCode(
  id: string,
  body: { label?: string | null; preferredTemplateId?: string | null },
): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/qr-codes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function deleteQrCode(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/qr-codes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// ---- QR label templates ----------------------------------------------------

export type QrLabelLayout = 'nameplate' | 'minimal' | 'safety';
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrLabelFieldsPayload {
  header: { enabled: boolean; text: string };
  model: { enabled: boolean; labelOverride: string | null };
  serial: { enabled: boolean; labelOverride: string | null };
  site: { enabled: boolean; labelOverride: string | null };
  location: { enabled: boolean; labelOverride: string | null };
  description: { enabled: boolean; text: string };
  idCode: { enabled: boolean; labelOverride: string | null };
}

export interface AdminQrLabelTemplate {
  id: string;
  organizationId: string;
  organizationName?: string;
  name: string;
  isDefault: boolean;
  layout: QrLabelLayout;
  accentColor: string;
  logoStorageKey: string | null;
  qrSize: number;
  qrErrorCorrection: QrErrorCorrection;
  fields: QrLabelFieldsPayload;
  createdAt: string;
  updatedAt: string;
}

export async function listQrLabelTemplates(): Promise<AdminQrLabelTemplate[]> {
  const res = await fetch(`${API_BASE}/admin/qr-label-templates`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrLabelTemplate[];
}

export async function getQrLabelTemplate(id: string): Promise<AdminQrLabelTemplate> {
  const res = await fetch(
    `${API_BASE}/admin/qr-label-templates/${encodeURIComponent(id)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrLabelTemplate;
}

export async function createQrLabelTemplate(
  body: Partial<Omit<AdminQrLabelTemplate, 'id' | 'createdAt' | 'updatedAt' | 'organizationName'>> & {
    organizationId: string;
    name: string;
  },
): Promise<AdminQrLabelTemplate> {
  const res = await fetch(`${API_BASE}/admin/qr-label-templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrLabelTemplate;
}

export async function updateQrLabelTemplate(
  id: string,
  body: Partial<Omit<AdminQrLabelTemplate, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'organizationName'>>,
): Promise<AdminQrLabelTemplate> {
  const res = await fetch(
    `${API_BASE}/admin/qr-label-templates/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrLabelTemplate;
}

export async function deleteQrLabelTemplate(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/qr-label-templates/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export const DEFAULT_LABEL_TEMPLATE_FIELDS: QrLabelFieldsPayload = {
  header: { enabled: false, text: '' },
  model: { enabled: true, labelOverride: null },
  serial: { enabled: true, labelOverride: null },
  site: { enabled: true, labelOverride: null },
  location: { enabled: true, labelOverride: null },
  description: { enabled: false, text: '' },
  idCode: { enabled: true, labelOverride: 'ID' },
};
