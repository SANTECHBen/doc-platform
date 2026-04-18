import { createDb, type Database } from '@platform/db';
import { createAnthropic, Anthropic } from '@platform/ai';
import { createFsStorage, type Storage } from './storage';
import { createS3Storage } from './storage-s3';
import type { Env } from './env';

export interface AppContext {
  env: Env;
  db: Database;
  anthropic: Anthropic;
  storage: Storage;
}

export function createContext(env: Env): AppContext {
  const apiBaseUrl = `http://${env.API_HOST === '0.0.0.0' ? 'localhost' : env.API_HOST}:${env.API_PORT}`;

  // Prefer S3-compatible storage when configured (production). Fall back to
  // filesystem for local dev.
  const storage =
    env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_PUBLIC_URL
      ? createS3Storage({
          ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
          region: env.S3_REGION,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          bucket: env.S3_BUCKET,
          publicBaseUrl: env.S3_PUBLIC_URL,
        })
      : createFsStorage({
          rootDir: env.UPLOADS_DIR,
          publicBaseUrl: apiBaseUrl,
        });

  return {
    env,
    db: createDb(env.DATABASE_URL),
    anthropic: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL }),
    storage,
  };
}
