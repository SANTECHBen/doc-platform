'use client';

// LocalStorage-backed CRUD for saved QR designs. Each entry holds a name,
// a savedAt timestamp, and the full QrStyleSpec (including any embedded
// logo data URI), so a design round-trips byte-for-byte when re-opened.
//
// LocalStorage is per-origin and per-browser — designs don't sync between
// devices. That's acceptable for v1 (single-user authoring on a single
// machine). A future server-side store can adopt the same shape by
// promoting `id` to a server PK and adding `organizationId`.

import { DEFAULT_QR_SPEC, type QrStyleSpec } from '@/lib/qr-style';

const STORAGE_KEY = 'qr-designer:saved-designs:v1';

export interface SavedDesign {
  id: string;
  name: string;
  savedAt: string; // ISO timestamp
  spec: QrStyleSpec;
}

interface StorageEnvelope {
  version: 1;
  designs: SavedDesign[];
}

// LocalStorage write guard: above ~5 MB most browsers throw QuotaExceeded.
// A typical design without a logo is <1 KB; with a 1 MB PNG logo embedded as
// base64 it bloats to ~1.3 MB. We refuse to save above this cap so users
// don't lose unrelated entries to a single huge logo.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function read(): StorageEnvelope {
  if (typeof window === 'undefined') return { version: 1, designs: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, designs: [] };
    const parsed = JSON.parse(raw) as StorageEnvelope;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.designs)) {
      return { version: 1, designs: [] };
    }
    return parsed;
  } catch {
    // Corrupt JSON — start fresh rather than crash the designer.
    return { version: 1, designs: [] };
  }
}

function write(envelope: StorageEnvelope): void {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_TOTAL_BYTES) {
    throw new Error(
      `Saved designs would exceed the ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB local cap.` +
        ' Try removing a large logo or deleting an old design.',
    );
  }
  window.localStorage.setItem(STORAGE_KEY, serialized);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** List all saved designs, newest-first by savedAt. */
export function listSavedDesigns(): SavedDesign[] {
  const env = read();
  return [...env.designs].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Fetch a single saved design by id, or null if missing. */
export function getSavedDesign(id: string): SavedDesign | null {
  return read().designs.find((d) => d.id === id) ?? null;
}

/**
 * Create a new saved design or update an existing one (by id). The caller
 * receives the saved entry back so it can update local state with the
 * canonical savedAt timestamp / generated id.
 */
export function saveDesign(args: {
  id?: string;
  name: string;
  spec: QrStyleSpec;
}): SavedDesign {
  const env = read();
  const now = new Date().toISOString();
  const trimmedName = args.name.trim() || 'Untitled design';
  if (args.id) {
    const idx = env.designs.findIndex((d) => d.id === args.id);
    if (idx >= 0) {
      const updated: SavedDesign = {
        ...env.designs[idx]!,
        name: trimmedName,
        spec: args.spec,
        savedAt: now,
      };
      env.designs[idx] = updated;
      write(env);
      return updated;
    }
  }
  const created: SavedDesign = {
    id: makeId(),
    name: trimmedName,
    spec: args.spec,
    savedAt: now,
  };
  env.designs.push(created);
  write(env);
  return created;
}

/** Rename a saved design. */
export function renameSavedDesign(id: string, name: string): SavedDesign | null {
  const env = read();
  const idx = env.designs.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const updated: SavedDesign = {
    ...env.designs[idx]!,
    name: name.trim() || 'Untitled design',
    savedAt: new Date().toISOString(),
  };
  env.designs[idx] = updated;
  write(env);
  return updated;
}

/** Delete a saved design. No-op if the id isn't found. */
export function deleteSavedDesign(id: string): void {
  const env = read();
  env.designs = env.designs.filter((d) => d.id !== id);
  write(env);
}

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

function makeId(): string {
  // crypto.randomUUID is available in all modern browsers we ship to;
  // fall back to a timestamped pseudo-id in the unlikely case it's missing.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
