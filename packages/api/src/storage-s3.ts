import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Storage } from './storage';

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
    async putBuffer({ buffer, filename, contentType }) {
      const sha = createHash('sha256').update(buffer).digest('hex');
      const prefix = sha.slice(0, 2);
      const safeName = sanitizeFilename(filename);
      const storageKey = `${prefix}/${sha}/${safeName}`;
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: storageKey,
          Body: buffer,
          ContentType: contentType,
          // Set cache headers: content-addressed keys are immutable.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      return { storageKey, size: buffer.length, sha256: sha };
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
      return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
    },
  };
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.length > 0 ? base : 'file';
}
