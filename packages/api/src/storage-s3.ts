import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
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

    async putStream({ body, filename, contentType }) {
      // Multipart upload — sha256 isn't known until the body finishes,
      // so the key is UUID-based (no content-addressing). Hash is still
      // computed in-flight through a pass-through tap.
      const id = randomUUID();
      const prefix = id.slice(0, 2);
      const safeName = sanitizeFilename(filename);
      const storageKey = `${prefix}/${id}/${safeName}`;
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
      return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
    },
  };
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.length > 0 ? base : 'file';
}
