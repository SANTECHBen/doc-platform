'use client';

// Server-backed CRUD for saved QR designs. Designs are persisted to the
// platform DB via /admin/qr-designs and scoped to the user's organization,
// so anyone in the same org sees the same library and designs survive
// browser data clears, device changes, or signing in from another machine.
//
// Backwards-compat: an earlier release saved designs to localStorage. We
// keep a reader for that legacy store here so the designer can offer a
// one-time "upload these N to the server" migration.

import {
  createQrDesign,
  deleteQrDesign,
  listQrDesigns,
  updateQrDesign,
  type AdminQrDesign,
} from '@/lib/api';
import { DEFAULT_QR_SPEC, type QrStyleSpec } from '@/lib/qr-style';

// -----------------------------------------------------------------------------
// Domain
// -----------------------------------------------------------------------------

export interface SavedDesign {
  id: string;
  name: string;
  /** ISO timestamp of the most recent save. */
  savedAt: string;
  spec: QrStyleSpec;
  /** Whether the viewer is allowed to update / delete this design. False
   *  when a colleague saved it; viewers can still load + duplicate. */
  canEdit: boolean;
  ownerDisplayName: string | null;
}

function toSaved(d: AdminQrDesign): SavedDesign {
  return {
    id: d.id,
    name: d.name,
    savedAt: d.updatedAt,
    spec: d.spec as unknown as QrStyleSpec,
    canEdit: d.canEdit,
    ownerDisplayName: d.ownerDisplayName,
  };
}

// -----------------------------------------------------------------------------
// Public async API (calls server)
// -----------------------------------------------------------------------------

export async function fetchSavedDesigns(): Promise<SavedDesign[]> {
  const rows = await listQrDesigns();
  return rows.map(toSaved);
}

export async function saveDesignToServer(args: {
  id?: string;
  name: string;
  spec: QrStyleSpec;
}): Promise<SavedDesign> {
  const trimmedName = args.name.trim() || 'Untitled design';
  // The server schema validates that spec is a JSON object — we cast to the
  // record type so the API client accepts it. The renderer's QrStyleSpec
  // shape is a strict subset of Record<string, unknown> at runtime.
  const specPayload = args.spec as unknown as Record<string, unknown>;
  if (args.id) {
    const updated = await updateQrDesign(args.id, {
      name: trimmedName,
      spec: specPayload,
    });
    return toSaved(updated);
  }
  const created = await createQrDesign({ name: trimmedName, spec: specPayload });
  return toSaved(created);
}

export async function renameSavedDesignOnServer(
  id: string,
  name: string,
): Promise<SavedDesign> {
  const updated = await updateQrDesign(id, {
    name: name.trim() || 'Untitled design',
  });
  return toSaved(updated);
}

export async function deleteSavedDesignFromServer(id: string): Promise<void> {
  await deleteQrDesign(id);
}

// -----------------------------------------------------------------------------
// Suggestions / helpers
// -----------------------------------------------------------------------------

/** Suggest a default name for a new save based on the spec's content. */
export function defaultDesignName(spec: QrStyleSpec): string {
  const data = spec.data?.trim();
  if (!data) return 'Untitled design';
  try {
    const u = new URL(data);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return data.slice(0, 40);
  }
}

/** Return whether the given spec equals the defaults — used to disable Save
 *  when nothing meaningful would be persisted. */
export function isDefaultSpec(spec: QrStyleSpec): boolean {
  return (
    JSON.stringify({ ...spec, data: '' }) ===
    JSON.stringify({ ...DEFAULT_QR_SPEC, data: '' })
  );
}

// -----------------------------------------------------------------------------
// Legacy localStorage reader — used by the one-time migration prompt only.
// Kept here (not deleted) so users who saved designs before the server
// upgrade can still find them. Once a user dismisses or completes the
// migration we mark the LS store consumed and skip on future visits.
// -----------------------------------------------------------------------------

const LEGACY_STORAGE_KEY = 'qr-designer:saved-designs:v1';
const LEGACY_MIGRATION_DONE_KEY = 'qr-designer:legacy-migrated:v1';

interface LegacyEnvelope {
  version: 1;
  designs: Array<{
    id: string;
    name: string;
    savedAt: string;
    spec: QrStyleSpec;
  }>;
}

export interface LegacyDesign {
  id: string;
  name: string;
  savedAt: string;
  spec: QrStyleSpec;
}

/** Read legacy designs out of localStorage. Returns [] if absent or if the
 *  user has already completed (or dismissed) the migration. */
export function readLegacyLocalStorageDesigns(): LegacyDesign[] {
  if (typeof window === 'undefined') return [];
  try {
    if (window.localStorage.getItem(LEGACY_MIGRATION_DONE_KEY) === '1') return [];
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LegacyEnvelope;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.designs)) return [];
    return parsed.designs.map((d) => ({
      id: d.id,
      name: d.name,
      savedAt: d.savedAt,
      spec: d.spec,
    }));
  } catch {
    return [];
  }
}

/** Mark the legacy store consumed so the migration banner never shows
 *  again for this browser. We leave the actual blob in place — that lets
 *  a curious user recover anything that didn't make the round-trip. */
export function markLegacyMigrationDone(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LEGACY_MIGRATION_DONE_KEY, '1');
  } catch {
    // localStorage may be disabled — the banner will simply reappear next
    // visit, which is acceptable.
  }
}

/** Upload legacy designs to the server one-by-one. Returns counts so the
 *  caller can surface success or partial-failure feedback. */
export async function migrateLegacyDesigns(legacy: LegacyDesign[]): Promise<{
  uploaded: number;
  failed: number;
  errors: string[];
}> {
  let uploaded = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const d of legacy) {
    try {
      await createQrDesign({
        name: d.name,
        spec: d.spec as unknown as Record<string, unknown>,
      });
      uploaded += 1;
    } catch (e) {
      failed += 1;
      errors.push(`${d.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { uploaded, failed, errors };
}
