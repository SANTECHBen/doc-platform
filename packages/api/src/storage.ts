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
export interface Storage {
  putBuffer(input: {
    buffer: Buffer;
    filename: string;
    contentType: string;
  }): Promise<{ storageKey: string; size: number; sha256: string }>;

  /** Stream-friendly variant for large uploads. The body is piped straight
   *  into the storage backend (multipart S3 upload for R2/MinIO/AWS) so the
   *  whole file never sits in memory. Returns sha256 computed in-flight. */
  putStream(input: {
    body: NodeJS.ReadableStream;
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

    async putStream({ body, filename, contentType: _ct }) {
      await ensureRoot();
      const id = randomUUID();
      const prefix = id.slice(0, 2);
      const dir = path.join(rootDir, prefix, id);
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
        storageKey: [prefix, id, safeName].join('/'),
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
