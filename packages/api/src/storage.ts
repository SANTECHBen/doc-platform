import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';

// Filesystem-backed storage for dev. Same interface will back MinIO / S3 later;
// swap the adapter without touching callers. Keys include a content hash so
// immutable content-addressed delivery is possible later (CDN caching, etc.).
export interface Storage {
  putBuffer(input: {
    buffer: Buffer;
    filename: string;
    contentType: string;
  }): Promise<{ storageKey: string; size: number; sha256: string }>;

  stream(
    storageKey: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number; contentType?: string } | null>;

  publicUrl(storageKey: string): string;
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
    async putBuffer({ buffer, filename, contentType: _ct }) {
      await ensureRoot();
      const sha = createHash('sha256').update(buffer).digest('hex');
      // Path: <sha prefix>/<sha>/<filename>. Prefix spreads files across
      // directories to avoid one giant folder.
      const prefix = sha.slice(0, 2);
      const dir = path.join(rootDir, prefix, sha);
      await fs.mkdir(dir, { recursive: true });
      const safeName = sanitizeFilename(filename);
      const fullPath = path.join(dir, safeName);
      await fs.writeFile(fullPath, buffer);
      const storageKey = [prefix, sha, safeName].join('/');
      return { storageKey, size: buffer.length, sha256: sha };
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
      return `${publicBaseUrl}/files/${storageKey}`;
    },
  };
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
