// Search scope resolver — turns the caller's context into the
// (contentPackVersionIds, ownerOrganizationIds) pair the search retriever
// uses to gate results.
//
// Two scope modes:
//
//   resolveSearchScopeForAssetInstance(assetInstanceId):
//     PWA voice-search path. The tech scanned an asset; we narrow to that
//     asset's pinned content pack version plus the version's overlays so
//     only documentation the tech has access to in this context surfaces.
//
//   resolveSearchScopeForUser(scope):
//     Admin global-search path. Returns every content pack version visible
//     to the caller via their org scope. Broader by design.
//
// Both modes prevent cross-tenant leakage — versions outside the org tree
// never enter the result set.

import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';
import type { Scope } from '../middleware/scope.js';

export interface SearchScope {
  contentPackVersionIds: string[];
  ownerOrganizationIds: string[];
}

const EMPTY: SearchScope = { contentPackVersionIds: [], ownerOrganizationIds: [] };

/**
 * Resolve the scope for a tech scanning an asset. Returns every content
 * pack version this asset has access to:
 *   - The asset's pinned version (the version the tech is actually viewing).
 *   - Plus every dealer / site overlay version that targets the same base
 *     pack and belongs to an org in the asset's org chain.
 *
 * Returning an empty scope (e.g., asset has no pinned version) short-
 * circuits the retriever to zero results — preferred over a fatal error
 * because the PWA's voice-search UI should still render its empty state.
 */
export async function resolveSearchScopeForAssetInstance(
  db: Database,
  assetInstanceId: string,
): Promise<SearchScope> {
  const asset = await db.query.assetInstances.findFirst({
    where: eq(schema.assetInstances.id, assetInstanceId),
    with: { model: true },
  });
  if (!asset || !asset.pinnedContentPackVersionId) return EMPTY;

  // Fetch the pinned version with its pack.
  const pinned = await db.query.contentPackVersions.findFirst({
    where: eq(schema.contentPackVersions.id, asset.pinnedContentPackVersionId),
    with: { pack: true },
  });
  if (!pinned || !pinned.pack) return EMPTY;

  // Asset model's site (if any) → owner org of the site for the additional
  // overlay candidates. We use the asset's `siteId` not the model's because
  // the dealer/site overlay is selected per instance.
  const candidateOrgIds = new Set<string>();
  candidateOrgIds.add(pinned.pack.ownerOrganizationId);

  // Walk the asset's owner org's parent chain — content packs owned by any
  // org in the chain are candidates. This handles dealer-published packs
  // that target the OEM's base pack.
  const assetOrgIds = await orgChainFromAsset(db, asset.id);
  for (const id of assetOrgIds) candidateOrgIds.add(id);

  // Find every published version of any pack whose `basePackId` equals the
  // pinned version's pack id (i.e., overlays on top of this base) OR whose
  // id equals the pinned version's pack id (i.e., the base itself).
  const candidatePacks = await db.query.contentPacks.findMany({
    where: inArray(
      schema.contentPacks.ownerOrganizationId,
      [...candidateOrgIds],
    ),
  });
  // Filter to packs that target our pinned version's pack (overlays) OR
  // that ARE the pinned version's pack (base). Asset model membership is
  // also a gate: cross-model packs should not leak in.
  const wantedPackIds = candidatePacks
    .filter(
      (p) =>
        (p.id === pinned.pack.id || p.basePackId === pinned.pack.id) &&
        p.assetModelId === pinned.pack.assetModelId,
    )
    .map((p) => p.id);

  // For each wanted pack, take its latest published version (overlays
  // version independently). We treat the asset's pinned version as
  // canonical for the base pack — for overlays we pick the latest
  // published since v1 doesn't have overlay version pinning per asset.
  const versions = await db.query.contentPackVersions.findMany({
    where: and(
      inArray(schema.contentPackVersions.contentPackId, wantedPackIds),
      eq(schema.contentPackVersions.status, 'published'),
    ),
  });
  // Group: keep one version per pack (the latest by versionNumber). For the
  // base pack, override with the pinned version so the tech sees the
  // version they're actually using.
  const latestByPack = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const prev = latestByPack.get(v.contentPackId);
    if (!prev || v.versionNumber > prev.versionNumber) {
      latestByPack.set(v.contentPackId, v);
    }
  }
  // Force-pin: the base pack's version is whatever the asset has pinned,
  // not "latest published."
  latestByPack.set(pinned.pack.id, pinned);

  const contentPackVersionIds = [...latestByPack.values()].map((v) => v.id);

  return {
    contentPackVersionIds,
    ownerOrganizationIds: [...candidateOrgIds],
  };
}

/**
 * Resolve scope for an authenticated user (no asset context). Returns every
 * content pack version visible via their org-tree scope.
 */
export async function resolveSearchScopeForUser(
  db: Database,
  scope: Scope,
): Promise<SearchScope> {
  if (scope.all) {
    // Platform admin: every published version. Cap to the published set
    // to keep draft work out of search results until publish.
    const versions = await db.query.contentPackVersions.findMany({
      where: eq(schema.contentPackVersions.status, 'published'),
      with: { pack: { columns: { ownerOrganizationId: true } } },
    });
    return {
      contentPackVersionIds: versions.map((v) => v.id),
      ownerOrganizationIds: [
        ...new Set(versions.map((v) => v.pack.ownerOrganizationId)),
      ],
    };
  }
  if (scope.orgIds.length === 0) return EMPTY;
  // Org-scoped: every published version owned by an org in scope.
  const packs = await db.query.contentPacks.findMany({
    where: inArray(schema.contentPacks.ownerOrganizationId, scope.orgIds),
    columns: { id: true },
  });
  if (packs.length === 0) return EMPTY;
  const versions = await db.query.contentPackVersions.findMany({
    where: and(
      inArray(
        schema.contentPackVersions.contentPackId,
        packs.map((p) => p.id),
      ),
      eq(schema.contentPackVersions.status, 'published'),
    ),
    columns: { id: true },
  });
  return {
    contentPackVersionIds: versions.map((v) => v.id),
    ownerOrganizationIds: scope.orgIds,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Org chain rooted at the asset's owning org. Used to widen the candidate
 * pool to dealer/site overlays. Walks parent_organization_id upward and
 * collects descendants of those parents (the dealer org tree).
 */
async function orgChainFromAsset(
  db: Database,
  assetInstanceId: string,
): Promise<string[]> {
  // Asset instance → site → site.organizationId. We don't have a direct
  // link from asset.id to org without the site join, but the asset table
  // stores siteId.
  const asset = await db.query.assetInstances.findFirst({
    where: eq(schema.assetInstances.id, assetInstanceId),
    columns: { siteId: true },
  });
  if (!asset?.siteId) return [];
  const site = await db.query.sites.findFirst({
    where: eq(schema.sites.id, asset.siteId),
    columns: { organizationId: true },
  });
  if (!site) return [];

  // Walk parent chain upward from the asset's owner org. Capped at 8 hops
  // — deeper chains are pathological in this data model.
  const chain: string[] = [site.organizationId];
  let cursor: string | null = site.organizationId;
  for (let i = 0; i < 8 && cursor; i += 1) {
    const orgRow: { parentOrganizationId: string | null } | undefined =
      await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, cursor),
        columns: { parentOrganizationId: true },
      });
    if (!orgRow?.parentOrganizationId) break;
    chain.push(orgRow.parentOrganizationId);
    cursor = orgRow.parentOrganizationId;
  }
  return chain;
}
