import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-7'),
  EMBEDDING_MODEL: z.string().default('voyage-3'),

  // Public origins — allowed by CORS, used in presented URLs.
  PUBLIC_PWA_ORIGIN: z.string().url().default('http://localhost:3000'),
  PUBLIC_ADMIN_ORIGIN: z.string().url().default('http://localhost:3002'),

  // File storage. If S3_BUCKET is set, the S3-compatible adapter is used.
  // Otherwise the filesystem adapter writes to UPLOADS_DIR (dev only).
  UPLOADS_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_PUBLIC_URL: z.string().url().optional(),

  // Permit x-dev-user header even when NODE_ENV=production. Interim until
  // full auth lands — set to '1' on the production API until then.
  ALLOW_DEV_AUTH: z.string().optional(),

  // Microsoft Entra ID OIDC. The API validates Bearer tokens against
  // Microsoft's JWKS; tokens must have audience = AUTH_MICROSOFT_CLIENT_ID.
  // AUTH_ALLOWED_TENANTS is an optional comma-separated allow-list of MS
  // tenant IDs (restricts admin to your own + invited customer tenants).
  // Empty allows any validated MS tenant.
  AUTH_MICROSOFT_CLIENT_ID: z.string().optional(),
  AUTH_ALLOWED_TENANTS: z.string().optional(),
  // Comma-separated email allow-list. Users signing in with one of these
  // emails get platform_admin=true set on every sign-in — grants "see all
  // orgs" override. Bootstraps SANTECH staff access without a chicken-and-
  // egg UI.
  PLATFORM_ADMIN_EMAILS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.S3_BUCKET) {
    const missing: string[] = [];
    if (!env.S3_ACCESS_KEY_ID) missing.push('S3_ACCESS_KEY_ID');
    if (!env.S3_SECRET_ACCESS_KEY) missing.push('S3_SECRET_ACCESS_KEY');
    if (!env.S3_PUBLIC_URL) missing.push('S3_PUBLIC_URL');
    if (missing.length > 0) {
      console.error(
        `S3_BUCKET is set but missing required siblings: ${missing.join(', ')}`,
      );
      process.exit(1);
    }
  }
  return env;
}
