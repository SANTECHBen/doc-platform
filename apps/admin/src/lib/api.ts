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

// Current-user identity. Drives super-admin UI affordances (e.g. editing
// already-published content packs). Server still enforces auth — the
// `platformAdmin` flag here is purely cosmetic; bypassing it client-side
// just means the user sees buttons whose API calls 403.
export type Me =
  | { authenticated: true; userId: string; organizationId: string; platformAdmin: boolean }
  | { authenticated: false };

export async function getMe(): Promise<Me> {
  const res = await fetch(`${API_BASE}/me`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) return { authenticated: false };
  const body = (await res.json()) as
    | { unauthenticated: true }
    | { userId: string; organizationId: string; platformAdmin: boolean };
  if ('unauthenticated' in body) return { authenticated: false };
  return {
    authenticated: true,
    userId: body.userId,
    organizationId: body.organizationId,
    platformAdmin: body.platformAdmin === true,
  };
}

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

/**
 * Mint a Mux instant-clip HLS URL for a [startMs..endMs] window of a
 * playback id. Used by the per-step clip preview in the draft editor
 * and the published-step clip-range editor — both need to play the
 * trimmed clip with audio so the reviewer can scrub the cut points.
 *
 * The URL is single-use-ish (carries a signed token good for ~1h on
 * signed-playback deployments; public deployments return a plain
 * `?asset_start_time=&asset_end_time=` URL). Re-mint whenever the clip
 * range changes — the URL embeds the bounds.
 */
export async function getMuxClipUrl(args: {
  playbackId: string;
  startMs: number;
  endMs: number;
}): Promise<{ url: string }> {
  const res = await fetch(`${API_BASE}/media/mux-clip-url`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(await authHeaders()),
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { url: string };
}

/**
 * Build Mux URLs (source HLS + image API) for a playback id, signed
 * with the appropriate JWTs when the deployment uses signed playback.
 * Used by the admin clip-preview player to stream the full source and
 * clamp playback bounds client-side via `currentTime` — that path
 * gives frame-accurate trim preview, whereas server-side instant-
 * clipping (`getMuxClipUrl`) is segment-aligned and can include up to
 * ~2s of extra context on each end.
 *
 * Mux's image.mux.com endpoints (thumbnails, animated gifs, storyboards)
 * each require their own audience-scoped token on signed deployments —
 * 'v' for video, 't' for thumbnails, 'g' for gifs. We mint 'v' + 't'
 * here so the player has the source manifest and the poster JPEG ready
 * without a second round trip.
 *
 * Cached per playbackId for the lifetime of the page — tokens expire in
 * ~1h, well beyond a typical authoring session, and refresh happens
 * naturally on the next mount.
 */
export async function getMuxPlaybackAccess(playbackId: string): Promise<{
  sourceUrl: string;
  /** Returns a thumbnail URL signed for the requested time. Public
   *  deployments return unsigned URLs from the same helper. */
  posterUrlFor: (timeSec: number, widthPx?: number) => string;
  policy: 'public' | 'signed';
}> {
  const [videoRes, thumbRes] = await Promise.all([
    fetch(`${API_BASE}/media/mux-playback-token`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(await authHeaders()),
      },
      body: JSON.stringify({ playbackId, audience: 'v' }),
    }),
    fetch(`${API_BASE}/media/mux-playback-token`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(await authHeaders()),
      },
      body: JSON.stringify({ playbackId, audience: 't' }),
    }),
  ]);
  if (!videoRes.ok) throw new Error(`API ${videoRes.status}: ${await videoRes.text()}`);
  if (!thumbRes.ok) throw new Error(`API ${thumbRes.status}: ${await thumbRes.text()}`);
  type TokenBody =
    | { policy: 'public'; playbackId: string }
    | { policy: 'signed'; playbackId: string; token: string; expiresIn: number };
  const videoBody = (await videoRes.json()) as TokenBody;
  const thumbBody = (await thumbRes.json()) as TokenBody;
  const sourceBase = `https://stream.mux.com/${encodeURIComponent(playbackId)}.m3u8`;
  const sourceUrl =
    videoBody.policy === 'signed'
      ? `${sourceBase}?token=${videoBody.token}`
      : sourceBase;
  const thumbToken =
    thumbBody.policy === 'signed' ? thumbBody.token : null;
  const posterUrlFor = (timeSec: number, widthPx = 480) => {
    const base = `https://image.mux.com/${encodeURIComponent(playbackId)}/thumbnail.jpg`;
    const qs = new URLSearchParams({
      time: String(Math.max(0, Math.floor(timeSec))),
      width: String(widthPx),
    });
    if (thumbToken) qs.set('token', thumbToken);
    return `${base}?${qs.toString()}`;
  };
  return { sourceUrl, posterUrlFor, policy: videoBody.policy };
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

export interface AssetModelPatch {
  modelCode?: string;
  displayName?: string;
  category?: string;
  description?: string | null;
}

/** Edit the core fields of an asset model. Owner org cannot be changed. */
export async function updateAssetModel(
  id: string,
  patch: AssetModelPatch,
): Promise<AdminAssetModel> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminAssetModel;
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
  /** 'authored' = OEM/dealer/site overlay packs (draft → published lifecycle).
   *  'field_captures' = always-draft per-asset-model pack holding tech-
   *  authored procedures. The list groups field_captures rows under their
   *  asset model with a FIELD badge. */
  kind: 'authored' | 'field_captures';
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
      aiIndexed: boolean;
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
  /** Field-authored procedures for this pack's asset model. Sourced from
   *  the always-draft per-model "field captures" pack and rendered as a
   *  section parallel to per-version Documents/Training. Empty array on
   *  packs that don't surface field captures (overlays, field-captures
   *  packs themselves). */
  fieldCaptures: Array<{
    id: string;
    title: string;
    verified: boolean;
    capturedByDisplayName: string | null;
    stepCount: number;
    scopeAssetInstanceId: string | null;
    createdAt: string;
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
  seq: number | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  organizationId: string;
  organization: string;
  actorUserId: string | null;
  actor: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuditEventsPage {
  rows: AdminAuditEvent[];
  nextCursor: number | null;
}

export interface AuditQuery {
  eventType?: string;
  eventPrefix?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  organizationId?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  cursor?: number;
}

function auditQueryString(query: AuditQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function listAuditEvents(query: AuditQuery = {}): Promise<AuditEventsPage> {
  const res = await fetch(`${API_BASE}/admin/audit-events${auditQueryString(query)}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AuditEventsPage;
}

export interface AuditFacets {
  eventTypes: string[];
  actors: Array<{ id: string; name: string }>;
}

export async function getAuditFacets(): Promise<AuditFacets> {
  const res = await fetch(`${API_BASE}/admin/audit-events/facets`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AuditFacets;
}

export interface AuditVerifyResult {
  ok: boolean;
  breaks: Array<{ organizationId: string; seq: number; reason: string }>;
  checked: number;
}

export async function verifyAuditChain(organizationId?: string): Promise<AuditVerifyResult> {
  const qs = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
  const res = await fetch(`${API_BASE}/admin/audit-events/verify${qs}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AuditVerifyResult;
}

// Downloads the filtered audit log as CSV. Uses fetch + blob (not a plain
// link) so the Bearer token rides along on the request.
export async function downloadAuditCsv(query: AuditQuery = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/audit-events/export${auditQueryString(query)}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface AdminAnalytics {
  windowDays: number;
  scope: { orgIds: string[] | 'all'; orgIdRequested: string | null };
  scans: number;
  hubViews: number;
  blockedScans: number;
  activeAssets: number;
  workOrdersOpened: number;
  workOrdersStatusChanges: number;
  procedureRunsStarted: number;
  procedureRunsFinished: number;
  procedureRunsAbandoned: number;
  contentPacksPublished: number;
  sectionsCreated: number;
  aiChatMessages: number | null;
  feedbackSubmissions: number;
  scansByDay: Array<{ day: string; count: number }>;
}

export async function getAnalytics(params: {
  days?: number;
  orgId?: string;
} = {}): Promise<AdminAnalytics> {
  const qs = new URLSearchParams();
  if (params.days != null) qs.set('days', String(params.days));
  if (params.orgId) qs.set('orgId', params.orgId);
  const res = await fetch(`${API_BASE}/admin/analytics?${qs}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminAnalytics;
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

// Pin an asset instance to a specific content pack version (any
// version, draft or published). For "give me whatever's latest published"
// use pinLatestVersion. For "I just moved a procedure back to v1.0.0
// and want my asset to see it" use this.
export async function pinInstanceToVersion(
  instanceId: string,
  contentPackVersionId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/asset-instances/${encodeURIComponent(instanceId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ pinnedContentPackVersionId: contentPackVersionId }),
    },
  );
  if (!res.ok) throw new Error(`Pin ${res.status}: ${await res.text()}`);
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
  //
  // IMPORTANT: authHeaders() is async (it fetches the NextAuth session to
  // get the current MS ID token). Resolve it BEFORE the synchronous XHR
  // setup — otherwise we iterate Promise's own properties and send the
  // request with no Authorization header, which the API rejects with 401.
  const headers = await authHeaders();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/admin/uploads`, true);
    for (const [k, v] of Object.entries(headers)) {
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
  /** Override the kind-aware AI-indexing default. Server uses true for
   *  authored content (markdown / structured_procedure) and false for
   *  uploaded media when this is omitted. */
  aiIndexed?: boolean;
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
    aiIndexed?: boolean;
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
  contentPackVersionId: string;
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
  imageStorageKey: string | null;
  imageUrl: string | null;
  site: { id: string; name: string; organization: string };
  pinnedVersion: { id: string; number: number; label: string | null } | null;
}

export async function updateAssetInstanceImage(
  id: string,
  imageStorageKey: string | null,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/asset-instances/${encodeURIComponent(id)}/image`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ imageStorageKey }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
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

// ---------------------------------------------------------------------------
// QR designs — saved styled QR designs from /qr-codes/designer.
// ---------------------------------------------------------------------------

export interface AdminQrDesign {
  id: string;
  organizationId: string;
  organizationName: string;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  ownerEmail: string | null;
  /** True when the current viewer can update/delete this design. */
  canEdit: boolean;
  name: string;
  /** Opaque JSON — the full QrStyleSpec the designer renders. */
  spec: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export async function listQrDesigns(): Promise<AdminQrDesign[]> {
  const res = await fetch(`${API_BASE}/admin/qr-designs`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrDesign[];
}

export async function getQrDesign(id: string): Promise<AdminQrDesign> {
  const res = await fetch(`${API_BASE}/admin/qr-designs/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrDesign;
}

export async function createQrDesign(body: {
  name: string;
  spec: Record<string, unknown>;
  organizationId?: string;
}): Promise<AdminQrDesign> {
  const res = await fetch(`${API_BASE}/admin/qr-designs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrDesign;
}

export async function updateQrDesign(
  id: string,
  body: { name?: string; spec?: Record<string, unknown> },
): Promise<AdminQrDesign> {
  const res = await fetch(`${API_BASE}/admin/qr-designs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminQrDesign;
}

export async function deleteQrDesign(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/qr-designs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Document Sections
// ---------------------------------------------------------------------------

export type DocumentSectionKind = 'page_range' | 'text_range' | 'time_range';

export interface AdminDocumentDetail {
  id: string;
  title: string;
  kind: DocumentKind;
  contentType: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  bodyMarkdown: string | null;
  extractedText: string | null;
  extractionStatus: string;
  extractionError: string | null;
  extractedAt: string | null;
  safetyCritical: boolean;
  /** When false, the AI chat retriever excludes this document's chunks
   *  from search. Defaults true for markdown / structured_procedure (curated
   *  authored content) and false for uploaded media (pdf / slides /
   *  schematic / file / video) until the admin reviews and opts in. */
  aiIndexed: boolean;
  /** PM schedules that reference this document. Always [] for non-procedure
   *  docs (only structured_procedure can be a PM target). Used by the doc
   *  detail page to render a "Used by N PMs" pill linking back to the
   *  asset model section that owns each schedule. */
  pmScheduleRefs: Array<{
    id: string;
    name: string;
    assetModelId: string;
    assetModelDisplayName: string;
  }>;
  language: string | null;
  orderingHint: number;
  storageKey: string | null;
  thumbnailStorageKey: string | null;
  fileUrl: string | null;
  thumbnailUrl: string | null;
  contentPackVersionId: string;
  contentPackId: string;
  contentPackName: string;
  /** 'authored' = OEM/dealer/site overlay packs (draft → published lifecycle).
   *  'field_captures' = always-draft pack with tech-captured procedures. */
  contentPackKind: 'authored' | 'field_captures';
  contentPackVersionNumber: number;
  contentPackVersionStatus: 'draft' | 'in_review' | 'published' | 'archived';
  ownerOrganizationId: string;
  /** Set when an admin/senior tech has reviewed + promoted a field-captured
   *  doc. Null on OEM-authored docs (publish lifecycle handles them). */
  fieldVerifiedAt: string | null;
  fieldVerifiedByUserId: string | null;
  fieldVerifiedByDisplayName: string | null;
  /** Set when the doc is scoped to one specific asset instance (rather than
   *  the whole asset model). Null = model-wide. */
  scopeAssetInstanceId: string | null;
  /** Tools / safety / verification / heroVideo metadata for procedure
   *  documents. null for non-procedure docs. The heroVideo sub-object,
   *  when present, includes a server-resolved `url` for preview. */
  procedureMetadata: AdminProcedureDocMetadata | null;
  createdAt: string;
}

export interface RequiredTools {
  common: string[];
  special: string[];
  consumables: string[];
}

export interface AdminProcedureDocMetadata {
  toolsRequired: RequiredTools;
  safety: { enabled: boolean; notes: string | null };
  verification: { enabled: boolean; notes: string | null };
  /** Explicit Maintenance-tab bucket. When null, the PWA falls back to a
   *  title-keyword heuristic. Set this from the procedure editor so the
   *  categorization survives renames and duplicates. */
  category?:
    | 'preventive_maintenance'
    | 'removal_replacement'
    | 'troubleshooting'
    | 'walkthrough'
    | null;
  /** Author-controlled overview fields. Rendered on the PWA intro
   *  screen — all optional, legacy procedures show only hero/tools. */
  summary?: string | null;
  estimatedMinutes?: number | null;
  skillLevel?: 'basic' | 'intermediate' | 'advanced' | null;
  heroVideo?: {
    /** Set when uploaded via the hero-video upload route. */
    storageKey?: string;
    /** Set when authored as an external link (YouTube/Vimeo/direct). */
    sourceUrl?: string;
    mime: string;
    sizeBytes?: number;
    caption?: string | null;
    /** Server-resolved URL — populated regardless of source kind. */
    url?: string;
  } | null;
}

export interface AdminUploadResult {
  storageKey: string;
  sha256?: string;
  size: number;
  contentType: string;
  originalFilename: string;
  url: string;
}

/** Generic upload helper — POST /admin/uploads. Used by the procedure
 *  hero-video flow and any other admin upload that doesn't have a
 *  dedicated route. Returns the storageKey + URL for downstream PATCH.
 *
 *  Uses XMLHttpRequest (not fetch) so `xhr.upload.onprogress` can drive
 *  a progress bar for multi-minute video uploads. */
export async function uploadAdminFile(
  file: File,
  options?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
): Promise<AdminUploadResult> {
  const form = new FormData();
  form.append('file', file);
  const headers = await authHeaders();
  return new Promise<AdminUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/admin/uploads`);
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.responseType = 'json';
    if (options?.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          options.onProgress!((e.loaded / e.total) * 100);
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as AdminUploadResult);
      } else {
        const body =
          typeof xhr.response === 'string'
            ? xhr.response
            : JSON.stringify(xhr.response ?? {});
        reject(new Error(`API ${xhr.status}: ${body}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.onabort = () => reject(new Error('Upload aborted.'));
    if (options?.signal) {
      options.signal.addEventListener('abort', () => xhr.abort());
    }
    xhr.send(form);
  });
}

/** PATCH /admin/documents/:id — updates a document's editable fields.
 *  Pass only the fields that change. */
export async function updateAdminDocument(
  id: string,
  patch: {
    title?: string;
    storageKey?: string;
    thumbnailStorageKey?: string | null;
    originalFilename?: string;
    contentType?: string;
    sizeBytes?: number;
    safetyCritical?: boolean;
    aiIndexed?: boolean;
    procedureMetadata?: AdminProcedureDocMetadata | null;
  },
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function verifyFieldDocument(documentId: string): Promise<{
  documentId: string;
  fieldVerifiedAt: string;
  fieldVerifiedByUserId: string;
}> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/verify`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    documentId: string;
    fieldVerifiedAt: string;
    fieldVerifiedByUserId: string;
  };
}

export interface AdminDocumentSection {
  id: string;
  documentId: string;
  kind: DocumentSectionKind;
  title: string;
  description: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  pageStart: number | null;
  pageEnd: number | null;
  /** Optional fractional crop on the first page (0..1, top-down). */
  startY: number | null;
  /** Optional fractional crop on the last page (0..1, top-down). */
  endY: number | null;
  textPageHint: number | null;
  anchorExcerpt: string | null;
  anchorContextBefore: string | null;
  anchorContextAfter: string | null;
  timeStartSeconds: number | null;
  timeEndSeconds: number | null;
  needsRevalidation: boolean;
  revalidationReason: string | null;
  sourceExtractionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateSectionInput =
  | {
      kind: 'page_range';
      title: string;
      description?: string | null;
      safetyCritical?: boolean;
      orderingHint?: number;
      pageStart: number;
      pageEnd: number;
      startY?: number | null;
      endY?: number | null;
    }
  | {
      kind: 'text_range';
      title: string;
      description?: string | null;
      safetyCritical?: boolean;
      orderingHint?: number;
      anchorExcerpt: string;
      anchorContextBefore?: string | null;
      anchorContextAfter?: string | null;
      textPageHint?: number | null;
    }
  | {
      kind: 'time_range';
      title: string;
      description?: string | null;
      safetyCritical?: boolean;
      orderingHint?: number;
      timeStartSeconds: number;
      timeEndSeconds: number;
    };

export interface UpdateSectionInput {
  title?: string;
  description?: string | null;
  safetyCritical?: boolean;
  orderingHint?: number;
  pageStart?: number;
  pageEnd?: number;
  startY?: number | null;
  endY?: number | null;
  anchorExcerpt?: string;
  anchorContextBefore?: string | null;
  anchorContextAfter?: string | null;
  textPageHint?: number | null;
  timeStartSeconds?: number;
  timeEndSeconds?: number;
  needsRevalidation?: boolean;
  revalidationReason?: string | null;
}

export interface AdminPartSection extends AdminDocumentSection {
  documentTitle: string;
  documentKind: DocumentKind;
}

export async function getAdminDocument(documentId: string): Promise<AdminDocumentDetail> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDocumentDetail;
}

export async function listSectionsForDocument(
  documentId: string,
): Promise<AdminDocumentSection[]> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/sections`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDocumentSection[];
}

export async function createSection(
  documentId: string,
  input: CreateSectionInput,
): Promise<AdminDocumentSection> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/sections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDocumentSection;
}

export async function updateSection(
  sectionId: string,
  input: UpdateSectionInput,
): Promise<AdminDocumentSection> {
  const res = await fetch(
    `${API_BASE}/admin/document-sections/${encodeURIComponent(sectionId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDocumentSection;
}

export async function deleteSection(sectionId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/document-sections/${encodeURIComponent(sectionId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function listPartsForSection(sectionId: string): Promise<LinkedPart[]> {
  const res = await fetch(
    `${API_BASE}/admin/document-sections/${encodeURIComponent(sectionId)}/parts`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as LinkedPart[];
}

export async function setPartsForSection(
  sectionId: string,
  partIds: string[],
): Promise<{ ok: true; count: number; added: number; removed: number }> {
  const res = await fetch(
    `${API_BASE}/admin/document-sections/${encodeURIComponent(sectionId)}/parts`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ partIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; count: number; added: number; removed: number };
}

export async function listSectionsForPart(partId: string): Promise<AdminPartSection[]> {
  const res = await fetch(
    `${API_BASE}/admin/parts/${encodeURIComponent(partId)}/sections`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminPartSection[];
}

export async function revalidateDocumentSections(
  documentId: string,
): Promise<{ accepted: number; flagged: number; total: number }> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/sections/revalidate`,
    { method: 'POST', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { accepted: number; flagged: number; total: number };
}

// ---------------------------------------------------------------------------
// Procedure steps (authoring) — for kind='structured_procedure' documents.
// Mirrors the document-sections surface; see admin-procedure-steps.ts in
// the API for the route definitions.
// ---------------------------------------------------------------------------

export type ProcedureStepKind =
  | 'instruction'
  | 'safety_check'
  | 'photo_required'
  | 'measurement_required';

export type MeasurementSpec =
  | {
      kind: 'numeric';
      label: string;
      unit: string;
      min?: number | null;
      max?: number | null;
      expected?: number | null;
      tolerancePct?: number | null;
    }
  | {
      kind: 'pass_fail';
      label: string;
      passLabel?: string;
      failLabel?: string;
    }
  | {
      kind: 'free_text';
      label: string;
      placeholder?: string;
      maxLen?: number;
    };

// Discriminated union for typed step content blocks. The author picks a
// block kind from a slash menu; the template owns visual style. This is
// what makes every procedure look identical regardless of who wrote it.
export type StepBlock =
  | { kind: 'paragraph'; text: string }
  | {
      kind: 'callout';
      tone: 'safety' | 'warning' | 'tip' | 'note';
      title?: string;
      text: string;
    }
  | { kind: 'bullet_list'; items: string[] }
  | { kind: 'numbered_list'; items: string[] }
  | {
      kind: 'key_value';
      columns: [string, string];
      rows: Array<[string, string]>;
    }
  | { kind: 'photo_inline'; storageKey: string; caption?: string };

// Admin-side step media. Mirrors packages/db ProcedureStepMedia. The
// drafter writes `video_clip` entries; admin uploads write 'image' or
// 'video' entries.
export type AdminStepMedia =
  | {
      kind: 'image';
      storageKey: string;
      mime: string;
      caption?: string;
      /** Resolved public URL — server fills this in from storage.publicUrl(). */
      url: string | null;
    }
  | {
      kind: 'video';
      storageKey: string;
      mime: string;
      caption?: string;
      url: string | null;
    }
  | {
      kind: 'video_clip';
      storageKey: string;
      mime: string;
      caption?: string;
      /** Poster image URL — resolves from storageKey (a JPEG still). */
      url: string | null;
      clip: {
        playbackId: string;
        startMs: number;
        endMs: number;
        streamUrl: string;
        aspectRatio?: string;
        orientation?: 'portrait' | 'landscape' | 'square';
      };
    };

// ---------------------------------------------------------------------------
// Procedure step categories — author-extensible semantic tags applied to
// sections (drives the PWA phase-progress strip's color/icon) and to
// individual steps (drives an in-body badge). Built-ins are seeded by the
// 0039 migration; orgs can also add custom categories.
// ---------------------------------------------------------------------------
export interface AdminProcedureStepCategory {
  id: string;
  /** NULL for built-in / platform-wide categories. */
  organizationId: string | null;
  name: string;
  /** Hex color, e.g. "#EAB308". Rendered verbatim as a CSS color. */
  color: string;
  /** Lucide icon name from the curated allowlist (the runner falls back
   *  to no icon for unknown values). */
  icon: string | null;
  sortOrder: number;
  /** True for built-ins (organization_id IS NULL). Read-only for org admins. */
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProcedureStepCategoryInput {
  name: string;
  color: string;
  icon?: string | null;
  sortOrder?: number;
}

export type UpdateProcedureStepCategoryInput = Partial<CreateProcedureStepCategoryInput>;

export async function listProcedureStepCategories(
  organizationId: string,
): Promise<AdminProcedureStepCategory[]> {
  const res = await fetch(
    `${API_BASE}/admin/organizations/${encodeURIComponent(organizationId)}/procedure-step-categories`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStepCategory[];
}

export async function createProcedureStepCategory(
  organizationId: string,
  input: CreateProcedureStepCategoryInput,
): Promise<AdminProcedureStepCategory> {
  const res = await fetch(
    `${API_BASE}/admin/organizations/${encodeURIComponent(organizationId)}/procedure-step-categories`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStepCategory;
}

export async function updateProcedureStepCategory(
  id: string,
  input: UpdateProcedureStepCategoryInput,
): Promise<AdminProcedureStepCategory> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-step-categories/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStepCategory;
}

export async function deleteProcedureStepCategory(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-step-categories/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

// Section grouping above procedure steps. Optional — a procedure can have
// zero sections (flat list) or N sections with steps grouped inside each.
export interface AdminProcedureSection {
  id: string;
  documentId: string;
  title: string;
  description: string | null;
  orderingHint: number;
  /** Optional semantic category — drives the PWA phase-progress strip's
   *  color and icon for this section. Null = neutral coloring. */
  categoryId: string | null;
  /** Resolved category DTO when categoryId is set. Server inlines this
   *  so the admin / runner can render without a second fetch. */
  category: AdminProcedureStepCategory | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminProcedureStep {
  id: string;
  documentId: string;
  /** Nullable: a step with no section renders above the first explicit
   *  section (orphan group). Set by the editor when adding inside a section. */
  sectionId: string | null;
  /** Optional sub-procedure link. When set, the PWA Job Aid renders a
   *  "Run sub-procedure" button below this step. Server validates that
   *  the link points at a structured_procedure in the same pack version. */
  linkedProcedureDocId: string | null;
  /** Optional subset of steps from the linked sub-procedure to play.
   *  Empty array = play the full linked procedure. Server validates
   *  every ID belongs to the linked doc. */
  linkedProcedureStepIds: string[];
  kind: ProcedureStepKind;
  title: string;
  bodyMarkdown: string | null;
  safetyCritical: boolean;
  orderingHint: number;
  requiresPhoto: boolean;
  minPhotoCount: number;
  measurementSpec: MeasurementSpec | null;
  /** Authored photos and videos attached to this step. */
  media: AdminStepMedia[];
  /** Typed structured content. New authoring writes here; legacy rows
   *  may still have content in bodyMarkdown until edited. */
  blocks: StepBlock[];
  /** Authored voiceover. Set by upload, in-browser recording, or AI
   *  generation. When present, the runner plays this file at run time
   *  instead of synthesizing TTS — better fidelity, zero per-play cost. */
  audioStorageKey: string | null;
  audioContentType: string | null;
  audioSizeBytes: number | null;
  audioDurationMs: number | null;
  audioSource: 'uploaded' | 'generated' | null;
  audioUrl: string | null;
  /** Reusable snippet reference. When set, the step's blocks/title come
   *  from procedure_snippets (always-latest) until snippetDetached flips
   *  on first inline edit. */
  snippetId: string | null;
  snippetDetached: boolean;
  /** Snippet provenance — non-null whenever snippetId is set. Lets the
   *  step card render a "From snippet: X" pill without a second fetch. */
  snippetBadge: SnippetBadge | null;
  /** Optional semantic category override for this individual step. Drives
   *  an in-body badge above the step title. When null, the runner falls
   *  back to the parent section's category (if any) for visual treatment. */
  categoryId: string | null;
  /** Resolved category DTO when categoryId is set. */
  category: AdminProcedureStepCategory | null;
  createdAt: string;
  updatedAt: string;
}

/** Snippet provenance surfaced on procedure step DTOs. */
export interface SnippetBadge {
  id: string;
  title: string;
  isPlatform: boolean;
  /** True once the step has been edited inline and no longer tracks the
   *  snippet. The badge still renders for provenance but the step content
   *  is now independent. */
  detached: boolean;
}

export interface ProcedureStepAudioResult {
  audioUrl: string;
  audioContentType: string;
  audioSizeBytes: number;
  audioSource: 'uploaded' | 'generated';
  voice?: string;
  updatedAt?: string;
}

export interface CreateProcedureSectionInput {
  title: string;
  description?: string | null;
  orderingHint?: number;
  /** Optional category — drives the section's color/icon on the PWA
   *  phase-progress strip. Null/omitted = neutral. */
  categoryId?: string | null;
}

export type UpdateProcedureSectionInput = Partial<CreateProcedureSectionInput>;

export async function listProcedureSections(
  documentId: string,
): Promise<AdminProcedureSection[]> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/procedure-sections`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureSection[];
}

export async function createProcedureSection(
  documentId: string,
  input: CreateProcedureSectionInput,
): Promise<AdminProcedureSection> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/procedure-sections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureSection;
}

export async function updateProcedureSection(
  sectionId: string,
  input: UpdateProcedureSectionInput,
): Promise<AdminProcedureSection> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-sections/${encodeURIComponent(sectionId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureSection;
}

export async function deleteProcedureSection(sectionId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-sections/${encodeURIComponent(sectionId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export async function reorderProcedureSections(
  documentId: string,
  orderedIds: string[],
): Promise<{ ok: true; count: number }> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/procedure-sections/reorder`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ orderedIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; count: number };
}

export interface CreateProcedureStepInput {
  kind: ProcedureStepKind;
  title: string;
  bodyMarkdown?: string | null;
  safetyCritical?: boolean;
  orderingHint?: number;
  /** Optional grouping. When null/omitted the step is an "orphan" rendered
   *  above any explicit sections. */
  sectionId?: string | null;
  /** Optional sub-procedure link. Server validates: must be a
   *  structured_procedure in the same content pack version, and not self. */
  linkedProcedureDocId?: string | null;
  /** Optional subset of steps from the linked sub-procedure. Empty / omitted
   *  = play the full procedure. */
  linkedProcedureStepIds?: string[];
  requiresPhoto?: boolean;
  minPhotoCount?: number;
  measurementSpec?: MeasurementSpec | null;
  blocks?: StepBlock[];
  /** Reusable snippet to attach. When set, the step's blocks/title resolve
   *  from procedure_snippets at read time. Server validates that the
   *  caller can read the snippet (org-scoped or platform-tier). */
  snippetId?: string | null;
  /** Optional category — drives a per-step badge in the runner. Pass
   *  null to clear; omit to leave unchanged on patches. */
  categoryId?: string | null;
}

export type UpdateProcedureStepInput = Partial<CreateProcedureStepInput>;

export interface AdminSiblingProcedure {
  id: string;
  title: string;
}

export async function listSiblingProcedures(
  documentId: string,
): Promise<AdminSiblingProcedure[]> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/sibling-procedures`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSiblingProcedure[];
}

export async function listProcedureSteps(
  documentId: string,
): Promise<AdminProcedureStep[]> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/procedure-steps`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStep[];
}

export async function createProcedureStep(
  documentId: string,
  input: CreateProcedureStepInput,
): Promise<AdminProcedureStep> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/procedure-steps`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStep;
}

export async function updateProcedureStep(
  stepId: string,
  input: UpdateProcedureStepInput,
): Promise<AdminProcedureStep> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStep;
}

export async function deleteProcedureStep(stepId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

/**
 * Retrim the AI-walkthrough clip on a *published* procedure step. Only
 * applies to steps that carry a video_clip media entry (drafter-built
 * walkthroughs). The window must be 2–20s; the server returns 400
 * otherwise so the editor can keep the previous value.
 */
export async function updateProcedureStepClipRange(
  stepId: string,
  range: { startMs: number; endMs: number },
): Promise<AdminProcedureStep> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/clip-range`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(range),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminProcedureStep;
}

export async function listPartsForProcedureStep(
  stepId: string,
): Promise<LinkedPart[]> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/parts`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as LinkedPart[];
}

export async function setPartsForProcedureStep(
  stepId: string,
  partIds: string[],
): Promise<{ ok: true; count: number; added: number; removed: number }> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/parts`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ partIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; count: number; added: number; removed: number };
}

export async function reorderProcedureSteps(
  documentId: string,
  orderedIds: string[],
): Promise<{ ok: true; count: number }> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(documentId)}/procedure-steps/reorder`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ orderedIds }),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; count: number };
}

// ---------------------------------------------------------------------------
// Per-step voiceover authoring.
// ---------------------------------------------------------------------------

export async function uploadProcedureStepAudio(
  stepId: string,
  file: File,
): Promise<ProcedureStepAudioResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/audio`,
    { method: 'POST', headers: await authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Audio upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureStepAudioResult;
}

export async function generateProcedureStepAudio(
  stepId: string,
  opts?: { voice?: string; script?: string },
): Promise<ProcedureStepAudioResult> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/audio/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(opts ?? {}),
    },
  );
  if (!res.ok) throw new Error(`Audio generate ${res.status}: ${await res.text()}`);
  return (await res.json()) as ProcedureStepAudioResult;
}

export async function deleteProcedureStepAudio(stepId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/audio`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`Audio delete ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Per-step media (photos / videos) authoring.
// ---------------------------------------------------------------------------

export async function uploadProcedureStepMedia(
  stepId: string,
  file: File,
): Promise<AdminStepMedia> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/media`,
    { method: 'POST', headers: await authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Media upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminStepMedia;
}

export async function deleteProcedureStepMedia(
  stepId: string,
  storageKey: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/media/${encodeURIComponent(storageKey)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`Media delete ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Move a document between content pack versions (same pack only). Used to
// rescue docs from accidental version splits without re-authoring.
// ---------------------------------------------------------------------------

export async function moveDocumentToVersion(params: {
  documentId: string;
  targetVersionId: string;
}): Promise<{
  ok: true;
  documentId: string;
  fromVersionId: string;
  toVersionId: string;
  changed: boolean;
}> {
  const res = await fetch(
    `${API_BASE}/admin/documents/${encodeURIComponent(params.documentId)}/move`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ targetVersionId: params.targetVersionId }),
    },
  );
  if (!res.ok) throw new Error(`Move ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    ok: true;
    documentId: string;
    fromVersionId: string;
    toVersionId: string;
    changed: boolean;
  };
}

// ---------------------------------------------------------------------------
// Duplicate an authored structured_procedure into a different content
// pack draft version. listDuplicateTargets enumerates draft versions
// the caller can author into for the chooser dialog.
// ---------------------------------------------------------------------------

export interface DuplicateTarget {
  packId: string;
  packName: string;
  packSlug: string;
  layerType: 'base' | 'dealer_overlay' | 'site_overlay';
  assetModel: string;
  owner: string;
  versionId: string;
  versionNumber: number;
  versionLabel: string | null;
  /** 'draft' for anyone in scope; 'published' only surfaces for platform
   *  admins (the server applies the bypass). Archived versions are
   *  excluded entirely. */
  versionStatus: 'draft' | 'published';
}

export async function listDuplicateTargets(): Promise<DuplicateTarget[]> {
  const res = await fetch(`${API_BASE}/admin/duplicate-targets`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`List duplicate targets ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { targets: DuplicateTarget[] };
  return data.targets;
}

export async function duplicateProcedure(params: {
  sourceDocumentId: string;
  targetVersionId: string;
  title?: string;
}): Promise<{
  documentId: string;
  packVersionId: string;
  title: string;
  stepCount: number;
}> {
  const res = await fetch(
    `${API_BASE}/admin/procedures/${encodeURIComponent(params.sourceDocumentId)}/duplicate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        targetVersionId: params.targetVersionId,
        ...(params.title ? { title: params.title } : {}),
      }),
    },
  );
  if (!res.ok) throw new Error(`Duplicate ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    documentId: string;
    packVersionId: string;
    title: string;
    stepCount: number;
  };
}

// ---------------------------------------------------------------------
// Preventive Maintenance — admin authoring
// ---------------------------------------------------------------------

export interface AdminPmSchedule {
  id: string;
  assetModelId: string;
  documentId: string | null;
  name: string;
  description: string | null;
  cadenceKind: 'days';
  cadenceValue: number;
  graceDays: number;
  disabled: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  document?: { id: string; title: string; kind: string } | null;
}

export interface AdminPmProcedureDoc {
  id: string;
  title: string;
  kind: string;
  contentPackVersionId: string;
  contentPack: { id: string; name: string } | null;
  contentPackVersion: {
    id: string;
    versionNumber: number;
    versionLabel: string | null;
  } | null;
}

export async function listPmSchedules(modelId: string): Promise<AdminPmSchedule[]> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/pm-schedules`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function listPmProcedureDocs(
  modelId: string,
): Promise<AdminPmProcedureDoc[]> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/procedure-documents`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createPmSchedule(
  modelId: string,
  body: {
    documentId?: string | null;
    name: string;
    description?: string | null;
    cadenceKind?: 'days';
    cadenceValue: number;
    graceDays?: number;
    disabled?: boolean;
  },
): Promise<AdminPmSchedule> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/pm-schedules`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updatePmSchedule(
  scheduleId: string,
  patch: Partial<{
    documentId: string | null;
    name: string;
    description: string | null;
    cadenceKind: 'days';
    cadenceValue: number;
    graceDays: number;
    disabled: boolean;
  }>,
): Promise<AdminPmSchedule> {
  const res = await fetch(
    `${API_BASE}/admin/pm-schedules/${encodeURIComponent(scheduleId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deletePmSchedule(scheduleId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/pm-schedules/${encodeURIComponent(scheduleId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
}

// --- PM Plans (checklist-style with per-row frequency) -------------------

export type PmPlanFrequency = 'D' | 'W' | 'M' | 'Q' | 'S' | 'Y';

export interface AdminPmPlanItem {
  id: string;
  planId: string;
  component: string;
  checkText: string;
  remarks: string | null;
  frequency: PmPlanFrequency;
  documentId: string | null;
  document: { id: string; title: string; kind: string } | null;
  orderingHint: number;
}

export interface AdminPmPlan {
  id: string;
  assetModelId: string;
  name: string;
  description: string | null;
  orderingHint: number;
  disabled: boolean;
  items: AdminPmPlanItem[];
}

export async function listPmPlans(modelId: string): Promise<AdminPmPlan[]> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/pm-plans`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createPmPlan(
  modelId: string,
  body: { name: string; description?: string | null },
): Promise<AdminPmPlan> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/pm-plans`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updatePmPlan(
  planId: string,
  patch: { name?: string; description?: string | null; disabled?: boolean },
): Promise<AdminPmPlan> {
  const res = await fetch(
    `${API_BASE}/admin/pm-plans/${encodeURIComponent(planId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deletePmPlan(planId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/pm-plans/${encodeURIComponent(planId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
}

export async function createPmPlanItem(
  planId: string,
  body: {
    component: string;
    checkText: string;
    remarks?: string | null;
    frequency: PmPlanFrequency;
    documentId?: string | null;
    /** Server defaults to appending at the end (max+100) when omitted.
     *  Provide a specific hint to slot the new item between existing
     *  rows — used by the "Add check to <component>" affordance to keep
     *  same-component rows grouped together. */
    orderingHint?: number;
  },
): Promise<AdminPmPlanItem> {
  const res = await fetch(
    `${API_BASE}/admin/pm-plans/${encodeURIComponent(planId)}/items`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updatePmPlanItem(
  itemId: string,
  patch: {
    component?: string;
    checkText?: string;
    remarks?: string | null;
    frequency?: PmPlanFrequency;
    documentId?: string | null;
  },
): Promise<AdminPmPlanItem> {
  const res = await fetch(
    `${API_BASE}/admin/pm-plan-items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deletePmPlanItem(itemId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/pm-plan-items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
}

// --- Troubleshooting Guides ---------------------------------------------

/** A single remedy step inside a cause. Renders as a bullet or numbered
 *  row in the admin grid and on the PWA; each step may carry its own
 *  procedure link. */
export interface AdminTroubleshootingRemedyStep {
  text: string;
  documentId?: string | null;
}

/** Paired cause/remedy entry — each represents one possible cause for
 *  the symptom, with its remedy expressed as one or more steps (bullet
 *  or numbered list) and optional per-step procedure links. The legacy
 *  single `remedy` string and per-cause `documentId` from 0028 are kept
 *  optional so older rows still deserialize until they're re-authored. */
export interface AdminTroubleshootingCause {
  cause: string;
  /** Legacy pre-0029 single-text remedy. Reading code should prefer
   *  `remedySteps` when populated. */
  remedy?: string | null;
  remedySteps?: AdminTroubleshootingRemedyStep[];
  remedyStyle?: 'bullet' | 'numbered';
  /** Legacy pre-0029 per-cause fallback procedure link. */
  documentId?: string | null;
}

/** Deprecated structured-item shape from 0027. Still present in DTOs
 *  so old data round-trips through the API, but the admin UI no longer
 *  writes here. */
export interface AdminTroubleshootingStructItem {
  text: string;
  documentId?: string | null;
}

export interface AdminTroubleshootingItem {
  id: string;
  guideId: string;
  symptom: string;
  cause: string | null;
  remedy: string | null;
  causeItems: AdminTroubleshootingStructItem[];
  remedyItems: AdminTroubleshootingStructItem[];
  causes: AdminTroubleshootingCause[];
  documentId: string | null;
  document: { id: string; title: string; kind: string } | null;
  orderingHint: number;
}

export interface AdminTroubleshootingGuide {
  id: string;
  assetModelId: string;
  name: string;
  description: string | null;
  orderingHint: number;
  disabled: boolean;
  items: AdminTroubleshootingItem[];
}

export async function listTroubleshootingGuides(
  modelId: string,
): Promise<AdminTroubleshootingGuide[]> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/troubleshooting-guides`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createTroubleshootingGuide(
  modelId: string,
  body: { name: string; description?: string | null },
): Promise<AdminTroubleshootingGuide> {
  const res = await fetch(
    `${API_BASE}/admin/asset-models/${encodeURIComponent(modelId)}/troubleshooting-guides`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateTroubleshootingGuide(
  guideId: string,
  patch: { name?: string; description?: string | null; disabled?: boolean },
): Promise<AdminTroubleshootingGuide> {
  const res = await fetch(
    `${API_BASE}/admin/troubleshooting-guides/${encodeURIComponent(guideId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deleteTroubleshootingGuide(guideId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/troubleshooting-guides/${encodeURIComponent(guideId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
}

export async function createTroubleshootingItem(
  guideId: string,
  body: {
    symptom: string;
    cause?: string | null;
    remedy?: string | null;
    causeItems?: AdminTroubleshootingStructItem[];
    remedyItems?: AdminTroubleshootingStructItem[];
    causes?: AdminTroubleshootingCause[];
    documentId?: string | null;
    orderingHint?: number;
  },
): Promise<AdminTroubleshootingItem> {
  const res = await fetch(
    `${API_BASE}/admin/troubleshooting-guides/${encodeURIComponent(guideId)}/items`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateTroubleshootingItem(
  itemId: string,
  patch: {
    symptom?: string;
    cause?: string | null;
    remedy?: string | null;
    causeItems?: AdminTroubleshootingStructItem[];
    remedyItems?: AdminTroubleshootingStructItem[];
    causes?: AdminTroubleshootingCause[];
    documentId?: string | null;
  },
): Promise<AdminTroubleshootingItem> {
  const res = await fetch(
    `${API_BASE}/admin/troubleshooting-items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deleteTroubleshootingItem(itemId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/troubleshooting-items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
}

export async function patchProcedureStepAudioDuration(
  stepId: string,
  audioDurationMs: number,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/procedure-steps/${encodeURIComponent(stepId)}/audio/duration`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ audioDurationMs }),
    },
  );
  if (!res.ok) throw new Error(`Audio duration ${res.status}: ${await res.text()}`);
}

// ===========================================================================
// AI video-walkthrough drafter
// ===========================================================================

export type ProcedureDraftRunStatus =
  | 'uploading'
  | 'transcribing'
  | 'storyboarding'
  | 'pending_admin_decision'
  | 'proposing'
  | 'awaiting_review'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ProcedureDraftTranscriptSource =
  | 'mux_captions'
  | 'whisper_fallback'
  | 'manual';

export type ProcedureDraftCategory =
  | 'preventive_maintenance'
  | 'removal_replacement'
  | 'troubleshooting'
  | 'walkthrough';

export interface AdminDraftRun {
  id: string;
  ownerOrganizationId: string;
  targetContentPackVersionId: string;
  targetDocumentId: string | null;
  proposedTitle: string;
  status: ProcedureDraftRunStatus;
  muxUploadId: string | null;
  muxAssetId: string | null;
  muxPlaybackId: string | null;
  sourceVideoDurationMs: number | null;
  sourceVideoSizeBytes: number | null;
  /** Mux-reported aspect ratio ("16:9", "9:16", "4:3", "1:1"). Null on
   *  runs created before this field landed or while the asset is still
   *  processing. */
  sourceVideoAspectRatio: string | null;
  /** Pre-classified orientation derived from sourceVideoAspectRatio. */
  sourceVideoOrientation: 'portrait' | 'landscape' | 'square' | null;
  /** Author-picked category (set on the draft reviewer before "Run AI").
   *  Drives the LLM prompt and post-process section grouping. Null until
   *  the admin makes a pick. */
  procedureCategory: ProcedureDraftCategory | null;
  transcriptSource: ProcedureDraftTranscriptSource | null;
  hasTranscript: boolean;
  hasStoryboard: boolean;
  error: string | null;
  pwaSubmitted: boolean;
  submittedByUserId: string | null;
  submittedFromAssetInstanceId: string | null;
  submissionNotes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDraftStepBlock {
  kind: 'paragraph' | 'callout' | 'bullet_list' | 'numbered_list' | 'key_value';
  // We type this loosely on the client; server validates against the
  // discriminated union.
  [key: string]: unknown;
}

export interface AdminDraftStepProposal {
  clientId: string;
  confidence: number;
  title: string;
  kind: ProcedureStepKind;
  voiceoverText: string;
  blocks: StepBlock[];
  /** Single-frame timestamp used as the poster JPEG for the per-step
   *  clip. Usually picked inside [clipStartMs, clipEndMs]. */
  keyframeTimestampMs: number;
  /** Inclusive start of the per-step Mux clip range (ms). The runner
   *  plays [clipStartMs..clipEndMs] from the source video on a loop. */
  clipStartMs: number;
  /** Exclusive end of the per-step Mux clip range (ms). */
  clipEndMs: number;
  safetyCritical: boolean;
  requiresPhoto: boolean;
  minPhotoCount: number;
  measurementSpec: MeasurementSpec | null;
  rationale?: string;
}

export interface AdminDraftProposalTree {
  schemaVersion: 1;
  summary?: string;
  warnings: string[];
  steps: AdminDraftStepProposal[];
}

export interface AdminDraftProposal {
  id: string;
  runId: string;
  version: number;
  content: AdminDraftProposalTree;
  summary: string | null;
  modelUsed: string | null;
  tokenUsage: { inputTokens: number; outputTokens: number; costUsd?: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDraftExecution {
  id: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  proposalVersion: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AdminDraftDetail {
  run: AdminDraftRun;
  proposal: AdminDraftProposal | null;
  executions: AdminDraftExecution[];
  playbackId: string | null;
  transcript: string | null;
}

export async function createProcedureDraft(input: {
  proposedTitle: string;
  targetContentPackVersionId: string;
  ownerOrganizationId: string;
}): Promise<{ runId: string; uploadId: string; uploadUrl: string }> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { runId: string; uploadId: string; uploadUrl: string };
}

export async function listProcedureDrafts(
  ownerOrganizationId?: string,
): Promise<AdminDraftRun[]> {
  const qs = ownerOrganizationId ? `?ownerOrganizationId=${ownerOrganizationId}` : '';
  const res = await fetch(`${API_BASE}/admin/procedure-drafts${qs}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDraftRun[];
}

export async function getProcedureDraft(id: string): Promise<AdminDraftDetail> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDraftDetail;
}

export async function patchProcedureDraftProposal(
  id: string,
  body: { version: number; content: AdminDraftProposalTree },
): Promise<AdminDraftProposal> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}/proposal`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminDraftProposal;
}

export async function executeProcedureDraft(
  id: string,
): Promise<{ executionId: string; targetDocumentId: string; streamToken: string | null }> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}/execute`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    executionId: string;
    targetDocumentId: string;
    streamToken: string | null;
  };
}

/** Force-refresh a stuck draft by polling Mux directly. Use when the
 *  webhook never advanced the status past uploading/transcribing. */
export async function refreshProcedureDraftFromMux(
  id: string,
): Promise<{ status: string; changed: string[]; notes: string[] }> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}/refresh-mux`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { status: string; changed: string[]; notes: string[] };
}

export async function cancelProcedureDraft(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}/cancel`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

/** Set or clear the procedure category on a draft. Admins set this on
 *  the reviewer page before tapping "Run AI" so the drafter has the
 *  right schema in mind. Pass null to clear. */
export async function setProcedureDraftCategory(
  id: string,
  procedureCategory: ProcedureDraftCategory | null,
): Promise<void> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}/category`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ procedureCategory }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

/** Start the LLM loop on a PWA-submitted draft that's pending admin
 *  decision. Returns a stream token for the propose-channel SSE. */
export async function runAiOnProcedureDraft(
  id: string,
): Promise<{ ok: true; streamToken: string | null }> {
  const res = await fetch(`${API_BASE}/admin/procedure-drafts/${id}/run-ai`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true; streamToken: string | null };
}

/** Mux Direct Upload — PUTs raw bytes from the browser to Mux. Reuses the
 *  upload URL minted by createProcedureDraft. */
export async function uploadDraftVideoToMux(
  uploadUrl: string,
  file: File,
  onProgress?: (frac: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Mux upload ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('Mux upload network error'));
    xhr.open('PUT', uploadUrl);
    xhr.send(file);
  });
}

// ===========================================================================
// Procedure snippets — reusable step content (Lockout-Tagout, Safety, etc.)
// ===========================================================================

export interface AdminSnippet {
  id: string;
  title: string;
  kind: ProcedureStepKind;
  isPlatform: boolean;
  ownerOrganizationId: string | null;
  tags: string[];
  updatedAt: string;
}

export interface AdminSnippetReferencePreview {
  stepId: string;
  stepTitle: string;
  documentId: string;
  documentTitle: string;
  ownerOrganizationId: string;
  contentPackVersionId: string;
}

export interface AdminSnippetDetail {
  id: string;
  title: string;
  kind: ProcedureStepKind;
  blocks: StepBlock[];
  tags: string[];
  isPlatform: boolean;
  ownerOrganizationId: string | null;
  /** Authored voiceover — same shape as AdminProcedureStep.audio*. When
   *  set, an attached step inherits this audio for runtime playback
   *  unless the step has its own audio override. */
  audioStorageKey: string | null;
  audioContentType: string | null;
  audioSizeBytes: number | null;
  audioDurationMs: number | null;
  audioSource: 'uploaded' | 'generated' | null;
  audioUrl: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  referenceCount: number;
  referencesPreview: AdminSnippetReferencePreview[];
}

export interface AdminSnippetRevision {
  id: string;
  snippetId: string;
  revisionNumber: number;
  title: string;
  blocks: StepBlock[];
  changeNote: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface CreateSnippetInput {
  title: string;
  kind?: ProcedureStepKind;
  blocks?: StepBlock[];
  tags?: string[];
  isPlatform?: boolean;
  /** Required when isPlatform=false. */
  ownerOrganizationId?: string | null;
}

export interface UpdateSnippetInput {
  title?: string;
  kind?: ProcedureStepKind;
  blocks?: StepBlock[];
  tags?: string[];
  changeNote?: string;
}

export interface ListSnippetsParams {
  q?: string;
  kind?: ProcedureStepKind;
  ownerOrganizationId?: string | null;
  includePlatform?: boolean;
  limit?: number;
  offset?: number;
}

export async function listAdminSnippets(
  params: ListSnippetsParams = {},
): Promise<AdminSnippet[]> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.kind) qs.set('kind', params.kind);
  if (params.ownerOrganizationId !== undefined && params.ownerOrganizationId !== null) {
    qs.set('ownerOrganizationId', params.ownerOrganizationId);
  }
  if (params.includePlatform !== undefined) {
    qs.set('includePlatform', String(params.includePlatform));
  }
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const url = `${API_BASE}/admin/snippets${qs.toString() ? `?${qs}` : ''}`;
  const res = await fetch(url, { cache: 'no-store', headers: await authHeaders() });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSnippet[];
}

export async function getAdminSnippet(id: string): Promise<AdminSnippetDetail> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(id)}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSnippetDetail;
}

export async function listSnippetRevisions(
  id: string,
  limit = 50,
): Promise<AdminSnippetRevision[]> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(id)}/revisions?limit=${limit}`,
    { cache: 'no-store', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSnippetRevision[];
}

export async function createAdminSnippet(
  input: CreateSnippetInput,
): Promise<AdminSnippetDetail> {
  const res = await fetch(`${API_BASE}/admin/snippets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSnippetDetail;
}

export async function updateAdminSnippet(
  id: string,
  input: UpdateSnippetInput,
): Promise<AdminSnippetDetail> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as AdminSnippetDetail;
}

export interface SnippetAudioResult {
  audioUrl: string;
  audioContentType: string;
  audioSizeBytes: number;
  audioSource: 'uploaded' | 'generated';
  voice?: string;
  updatedAt?: string;
}

export async function uploadSnippetAudio(
  snippetId: string,
  file: File,
): Promise<SnippetAudioResult> {
  const form = new FormData();
  form.append('audio', file, file.name);
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(snippetId)}/audio`,
    { method: 'POST', headers: await authHeaders(), body: form },
  );
  if (!res.ok) throw new Error(`Audio upload ${res.status}: ${await res.text()}`);
  return (await res.json()) as SnippetAudioResult;
}

export async function generateSnippetAudio(
  snippetId: string,
  input: { voice?: string; script?: string } = {},
): Promise<SnippetAudioResult> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(snippetId)}/audio/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new Error(`Audio generate ${res.status}: ${await res.text()}`);
  return (await res.json()) as SnippetAudioResult;
}

export async function deleteSnippetAudio(snippetId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(snippetId)}/audio`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (!res.ok) throw new Error(`Audio delete ${res.status}: ${await res.text()}`);
}

export async function patchSnippetAudioDuration(
  snippetId: string,
  audioDurationMs: number,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(snippetId)}/audio/duration`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ audioDurationMs }),
    },
  );
  if (!res.ok) throw new Error(`Audio duration ${res.status}: ${await res.text()}`);
}

export async function deleteAdminSnippet(
  id: string,
): Promise<{ ok: true } | { statusCode: 409; references: AdminSnippetReferencePreview[] }> {
  const res = await fetch(
    `${API_BASE}/admin/snippets/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: await authHeaders() },
  );
  if (res.status === 409) {
    const body = (await res.json()) as {
      statusCode: 409;
      references: AdminSnippetReferencePreview[];
    };
    return body;
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return (await res.json()) as { ok: true };
}

