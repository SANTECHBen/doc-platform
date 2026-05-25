import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import type { Storage } from './storage';
import { ownerOrgFromStorageKey } from './storage';

export interface S3StorageConfig {
  endpoint?: string; // R2/MinIO need this; AWS S3 leaves it undefined.
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  // Public base URL where objects can be fetched (R2 public bucket URL, or
  // a CloudFront/Cloudflare-fronted CDN origin).
  publicBaseUrl: string;
}

export function createS3Storage(cfg: S3StorageConfig): Storage {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // R2 and MinIO require path-style URLs; AWS works with either.
    forcePathStyle: !!cfg.endpoint,
  });

  return {
    async putBuffer({ buffer, filename, contentType, ownerOrganizationId }) {
      assertOrgId(ownerOrganizationId);
      const sha = createHash('sha256').update(buffer).digest('hex');
      // Tenant prefix first, then sha shard. Two tenants with identical
      // bytes get two distinct objects; same-tenant dupes still dedup.
      const prefix = sha.slice(0, 2);
      const safeName = sanitizeFilename(filename);
      const storageKey = `org/${ownerOrganizationId}/${prefix}/${sha}/${safeName}`;
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: storageKey,
          Body: buffer,
          ContentType: contentType,
          // Set cache headers: content-addressed keys are immutable.
          // Cache-Control still applies to the underlying object; the
          // signed URL it's fetched via (signedUrl()) carries its own TTL.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      return { storageKey, size: buffer.length, sha256: sha };
    },

    async putStream({ body, filename, contentType, ownerOrganizationId }) {
      assertOrgId(ownerOrganizationId);
      // Multipart upload — sha256 isn't known until the body finishes,
      // so the key is UUID-based (no content-addressing). Hash is still
      // computed in-flight through a pass-through tap.
      const id = randomUUID();
      const prefix = id.slice(0, 2);
      const safeName = sanitizeFilename(filename);
      const storageKey = `org/${ownerOrganizationId}/${prefix}/${id}/${safeName}`;
      const hash = createHash('sha256');
      let size = 0;
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      body.pipe(tap);
      const upload = new Upload({
        client,
        params: {
          Bucket: cfg.bucket,
          Key: storageKey,
          Body: tap,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        },
        // 8 MB parts — comfortable for video uploads, keeps memory
        // bounded even at 2 GB total.
        partSize: 8 * 1024 * 1024,
        queueSize: 4,
      });
      await upload.done();
      return { storageKey, size, sha256: hash.digest('hex') };
    },

    async stream(storageKey) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: cfg.bucket, Key: storageKey }),
        );
        if (!res.Body) return null;
        const body = res.Body as unknown as NodeJS.ReadableStream;
        return {
          stream: body,
          size: Number(res.ContentLength ?? 0),
          ...(res.ContentType ? { contentType: res.ContentType } : {}),
        };
      } catch {
        return null;
      }
    },

    publicUrl(storageKey) {
      // DEPRECATED for tenant-sensitive content — left in place so existing
      // call sites continue to function for non-sensitive assets and during
      // the migration. Callers serving tenant content MUST migrate to
      // signedUrl().
      return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
    },

    async signedUrl(storageKey, options) {
      const ttl = Math.max(60, Math.min(options?.ttlSeconds ?? 900, 3600));
      const cmd = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: storageKey,
        ...(options?.contentDisposition
          ? { ResponseContentDisposition: options.contentDisposition }
          : {}),
      });
      // Presigned GETs are time-limited, key-scoped, and don't grant any
      // other capability. The bucket itself should be private (no
      // public-read ACL) so unsigned URLs return 403.
      return getSignedUrl(client, cmd, { expiresIn: ttl });
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
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.length > 0 ? base : 'file';
}
