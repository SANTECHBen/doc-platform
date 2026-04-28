import { createDb, type Database } from '@platform/db';
import { createAnthropic, Anthropic } from '@platform/ai';
import { createFsStorage, type Storage } from './storage';
import { createS3Storage } from './storage-s3';
import { createMuxClient, type MuxClient } from './lib/mux';
import { createStreamTokenIssuer, type StreamTokenIssuer } from './lib/stream-token';
import type { Env } from './env';

export interface AppContext {
  env: Env;
  db: Database;
  anthropic: Anthropic;
  storage: Storage;
  // Onboarding-agent dependencies. Both are optional — only present when
  // AGENT_ENABLED=1 and the relevant env vars are set. Routes that require
  // them must guard at registration.
  mux?: MuxClient;
  streamTokens?: StreamTokenIssuer;
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

  const ctx: AppContext = {
    env,
    db: createDb(env.DATABASE_URL),
    anthropic: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL }),
    storage,
  };

  if (env.AGENT_ENABLED === '1') {
    if (env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET && env.MUX_WEBHOOK_SECRET) {
      ctx.mux = createMuxClient({
        tokenId: env.MUX_TOKEN_ID,
        tokenSecret: env.MUX_TOKEN_SECRET,
        webhookSecret: env.MUX_WEBHOOK_SECRET,
        playbackPolicy: env.MUX_PLAYBACK_POLICY,
        corsOrigin: env.PUBLIC_ADMIN_ORIGIN,
      });
    }
    if (env.STREAM_TOKEN_SECRET) {
      ctx.streamTokens = createStreamTokenIssuer(env.STREAM_TOKEN_SECRET);
    }
  }

  return ctx;
}
