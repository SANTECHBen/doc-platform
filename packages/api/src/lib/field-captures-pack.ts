// Field captures pack — auto-create one always-draft content pack per
// asset model so techs can author procedures from the PWA on site. The
// pack has kind='field_captures' (vs the usual 'authored'). It holds
// exactly one always-draft version; we never publish or version-bump it.
//
// The DB enforces uniqueness via a partial unique index:
//   content_packs_field_captures_uniq ON (asset_model_id) WHERE kind='field_captures'
// so concurrent first-captures from two techs race-cleanly: the second
// insert hits the unique violation, we recover by reading the existing row.

import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@platform/db';

interface EnsureResult {
  packId: string;
  versionId: string;
  /** True when this call created the pack/version; false on the hit path. */
  created: boolean;
}

/**
 * Returns the (pack, version) ids for the asset model's field-captures
 * pack, creating both lazily on first use. Idempotent — safe to call
 * before every authoring start.
 *
 * Caller must have already scope-checked the asset model. We do NOT do
 * scope checking here; this is a pure lookup-or-create utility.
 */
export async function ensureFieldCapturesVersion(
  db: Database,
  params: {
    assetModelId: string;
    /** Owner org for the new pack. Should be the asset model's owner so
     *  authorization on later operations resolves cleanly. */
    ownerOrganizationId: string;
  },
): Promise<EnsureResult> {
  // Hit path: pack + version already exist.
  const existing = await db.query.contentPacks.findFirst({
    where: and(
      eq(schema.contentPacks.assetModelId, params.assetModelId),
      eq(schema.contentPacks.kind, 'field_captures'),
    ),
    with: { versions: true },
  });
  if (existing) {
    const v = existing.versions.find((x) => x.status === 'draft');
    if (v) {
      return { packId: existing.id, versionId: v.id, created: false };
    }
    // Edge case: pack exists but draft version was somehow archived.
    // Create a fresh draft alongside.
    const [newVersion] = await db
      .insert(schema.contentPackVersions)
      .values({
        contentPackId: existing.id,
        versionNumber:
          (existing.versions.reduce(
            (acc, x) => Math.max(acc, x.versionNumber),
            0,
          ) ?? 0) + 1,
        status: 'draft',
      })
      .returning();
    if (!newVersion) throw new Error('Failed to create field captures version.');
    return { packId: existing.id, versionId: newVersion.id, created: true };
  }

  // Cold path: insert pack + version. Use a transaction so we don't end
  // up with a pack and no version on failure.
  return db.transaction(async (tx) => {
    // Defensive re-check inside the transaction in case another caller
    // raced us between the find above and the insert.
    const racewinner = await tx.query.contentPacks.findFirst({
      where: and(
        eq(schema.contentPacks.assetModelId, params.assetModelId),
        eq(schema.contentPacks.kind, 'field_captures'),
      ),
      with: { versions: true },
    });
    if (racewinner) {
      const v = racewinner.versions.find((x) => x.status === 'draft');
      if (v) return { packId: racewinner.id, versionId: v.id, created: false };
    }

    const [pack] = await tx
      .insert(schema.contentPacks)
      .values({
        assetModelId: params.assetModelId,
        ownerOrganizationId: params.ownerOrganizationId,
        layerType: 'site_overlay',
        kind: 'field_captures',
        name: 'Field captures',
        slug: `field-captures-${params.assetModelId.slice(0, 8)}`,
      })
      .returning();
    if (!pack) throw new Error('Failed to create field captures pack.');

    const [version] = await tx
      .insert(schema.contentPackVersions)
      .values({
        contentPackId: pack.id,
        versionNumber: 1,
        status: 'draft',
      })
      .returning();
    if (!version) throw new Error('Failed to create field captures version.');

    return { packId: pack.id, versionId: version.id, created: true };
  });
}
