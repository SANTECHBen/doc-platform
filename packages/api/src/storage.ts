import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

// Filesystem-backed storage for dev. Same interface will back MinIO / S3 later;
// swap the adapter without touching callers. `putBuffer` keys files by content
// hash (immutable, dedup-friendly); `putStream` uses a UUID key because the
// hash isn't known until the stream ends — used for large uploads where
// buffering the whole file in RAM is not viable.
//
// **Tenant scoping**: every storage key is prefixed with `org/<ownerOrgId>/`
// so two tenants cannot share an object even if their bytes happen to hash
// to the same value. Reads validate the prefix matches the caller's scope
// before serving. See storage-key shape in keyParts() below.
export interface Storage {
  putBuffer(input: {
    buffer: Buffer;
    filename: string;
    contentType: string;
    /** Owner org for tenant-prefixed key. Required — callers must derive
     *  this from request.auth or scan-session scope. */
    ownerOrganizationId: string;
  }): Promise<{ storageKey: string; size: number; sha256: string }>;

  /** Stream-friendly variant for large uploads. The body is piped straight
   *  into the storage backend (multipart S3 upload for R2/MinIO/AWS) so the
   *  whole file never sits in memory. Returns sha256 computed in-flight. */
  putStream(input: {
    body: NodeJS.ReadableStream;
    filename: string;
    contentType: string;
    ownerOrganizationId: string;
  }): Promise<{ storageKey: string; size: number; sha256: string }>;

  stream(
    storageKey: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number; contentType?: string } | null>;

  /** Public/perpetual URL — DEPRECATED for tenant-sensitive assets. Use
   *  `signedUrl()` for anything that should not be world-readable. Kept
   *  for FS adapter compatibility (dev) and for assets that are
   *  intentionally public (e.g., generic icons). */
  publicUrl(storageKey: string): string;

  /** Short-lived signed GET URL (preferred for tenant-sensitive assets).
   *  TTL defaults to 15 min; callers can override. The signed URL is
   *  scoped to GET on a single key — no listing, no PUT, no other key. */
  signedUrl(
    storageKey: string,
    options?: { ttlSeconds?: number; contentDisposition?: string },
  ): Promise<string>;

  /** Optional: short-lived signed PUT URL that lets the browser upload
   *  directly to the backing store, skipping the API server. Used for
   *  large media uploads where the per-machine bandwidth of the API
   *  relay becomes the bottleneck. Returns null on adapters that don't
   *  support presigned PUTs (the FS adapter in dev); callers fall back
   *  to multipart upload through the API in that case.
   *
   *  The returned key is deterministic — the client receives it
   *  alongside the URL and uses it to reference the object after the
   *  PUT succeeds. */
  presignPut?(input: {
    filename: string;
    contentType: string;
    ownerOrganizationId: string;
    ttlSeconds?: number;
  }): Promise<{ uploadUrl: string; storageKey: string }>;

  /**
   * Extract the owner-org segment from a storage key produced by
   * putBuffer/putStream. Returns null when the key is missing the
   * tenant prefix (legacy keys created before the security pass).
   */
  ownerOrgFromKey(storageKey: string): string | null;
}

/**
 * Parse storage key tenant prefix. Keys are `org/<uuid>/<rest>`. Legacy
 * keys without the prefix return null (the caller must decide whether to
 * deny or grandfather the read). Used by both adapters so the parsing
 * stays consistent.
 */
export function ownerOrgFromStorageKey(storageKey: string): string | null {
  const match = /^org\/([0-9a-f-]{36})\//i.exec(storageKey);
  return match ? match[1]! : null;
}

export function createFsStorage(params: { rootDir: string; publicBaseUrl: string }): Storage {
  const { rootDir, publicBaseUrl } = params;

  // Ensure root exists lazily — the server process may not have write access at
  // boot time in production, so we do it on first write and surface errors.
  let ready: Promise<void> | null = null;
  async function ensureRoot() {
    if (!ready) ready = fs.mkdir(rootDir, { recursive: true }).then(() => undefined);
    return ready;
  }

  return {
    async putBuffer({ buffer, filename, contentType: _ct, ownerOrganizationId }) {
      await ensureRoot();
      assertOrgId(ownerOrganizationId);
      const sha = createHash('sha256').update(buffer).digest('hex');
      // Path: org/<uuid>/<sha prefix>/<sha>/<filename>. Tenant prefix
      // first so two tenants with identical bytes don't share an object;
      // content-hash second so same-tenant duplicates still dedup.
      const prefix = sha.slice(0, 2);
      const dir = path.join(rootDir, 'org', ownerOrganizationId, prefix, sha);
      await fs.mkdir(dir, { recursive: true });
      const safeName = sanitizeFilename(filename);
      const fullPath = path.join(dir, safeName);
      await fs.writeFile(fullPath, buffer);
      const storageKey = ['org', ownerOrganizationId, prefix, sha, safeName].join('/');
      return { storageKey, size: buffer.length, sha256: sha };
    },

    async putStream({ body, filename, contentType: _ct, ownerOrganizationId }) {
      await ensureRoot();
      assertOrgId(ownerOrganizationId);
      const id = randomUUID();
      const prefix = id.slice(0, 2);
      const dir = path.join(rootDir, 'org', ownerOrganizationId, prefix, id);
      await fs.mkdir(dir, { recursive: true });
      const safeName = sanitizeFilename(filename);
      const fullPath = path.join(dir, safeName);
      const hash = createHash('sha256');
      let size = 0;
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(body, tap, createWriteStream(fullPath));
      return {
        storageKey: ['org', ownerOrganizationId, prefix, id, safeName].join('/'),
        size,
        sha256: hash.digest('hex'),
      };
    },

    async stream(storageKey) {
      const fullPath = resolveKey(rootDir, storageKey);
      if (!fullPath) return null;
      try {
        const stat = await fs.stat(fullPath);
        return { stream: createReadStream(fullPath), size: stat.size };
      } catch {
        return null;
      }
    },

    publicUrl(storageKey) {
      // Dev-only: serves through the API's /files handler which enforces
      // auth + scope before reading from disk.
      return `${publicBaseUrl}/files/${storageKey}`;
    },

    // FS adapter has no notion of "signed" URLs — the /files handler does
    // the auth check at request time. Return the same URL; the handler's
    // gate is what enforces scope.
    async signedUrl(storageKey) {
      return `${publicBaseUrl}/files/${storageKey}`;
    },

    ownerOrgFromKey(storageKey) {
      return ownerOrgFromStorageKey(storageKey);
    },
  };
}

function assertOrgId(id: string): void {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('storage: ownerOrganizationId must be a UUID');
  }
}

function sanitizeFilename(name: string): string {
  // Strip directory components and unsafe characters; keep the extension
  // intact so the Content-Type can be inferred by downstream tools.
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.length > 0 ? base : 'file';
}

function resolveKey(rootDir: string, storageKey: string): string | null {
  // Prevent directory traversal — only allow keys that resolve under rootDir.
  const joined = path.resolve(rootDir, storageKey);
  const root = path.resolve(rootDir);
  if (!joined.startsWith(root + path.sep) && joined !== root) return null;
  return joined;
}
