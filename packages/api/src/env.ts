import { z } from 'zod';

// Optional URL that treats an empty string the same as "not set". Bare
// `.url().optional()` rejects "" as an invalid URL even though the user
// clearly didn't intend to set anything — common when keys are scaffolded
// in .env without a value yet.
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().optional(),
);

// Optional string that treats "" as undefined. Same problem as optionalUrl
// for fields that are switches — `S3_BUCKET=` shouldn't trip the
// "S3_BUCKET set, siblings missing" check.
const optionalNonEmptyString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  // Chat / troubleshooter model. Sonnet 4.6 is the cost/accuracy sweet spot
  // for grounded RAG — Opus 4.7's edge on open-ended reasoning rarely shows
  // up when the LLM is given retrieved context and asked to answer. Roughly
  // 5x cheaper per turn than Opus.
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  // Verifier model for the two-pass grounding check. Cheap & fast — it's
  // doing a structured "does sentence X appear in chunk Y" classification.
  ANTHROPIC_VERIFIER_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  EMBEDDING_MODEL: z.string().default('voyage-3-large'),

  // OpenAI — used for voice (Whisper STT and tts-1-hd). Optional: when
  // unset, voice routes return 503 and the PWA disables voice features.
  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_STT_MODEL: z.string().default('whisper-1'),
  OPENAI_TTS_MODEL: z.string().default('tts-1-hd'),
  OPENAI_TTS_VOICE: z.string().default('alloy'),

  // Public origins — allowed by CORS, used in presented URLs.
  PUBLIC_PWA_ORIGIN: z.string().url().default('http://localhost:3000'),
  PUBLIC_ADMIN_ORIGIN: z.string().url().default('http://localhost:3002'),

  // File storage. If S3_BUCKET is set, the S3-compatible adapter is used.
  // Otherwise the filesystem adapter writes to UPLOADS_DIR (dev only).
  UPLOADS_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: optionalNonEmptyString,
  S3_SECRET_ACCESS_KEY: optionalNonEmptyString,
  S3_BUCKET: optionalNonEmptyString,
  S3_PUBLIC_URL: optionalUrl,

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

  // Shared HMAC secret with the PWA for verifying scan-session cookies.
  // The PWA mints eh_scan cookies (<qrCode>.<exp>.<hmac>) with this secret
  // and forwards the value on every API call as X-Scan-Session. The API
  // verifies the signature, resolves the QR → org, and uses that org as
  // the scope for endpoints called on behalf of a scanner (no user auth).
  // Must match apps/pwa env var of the same name. Minimum 32 chars.
  PWA_SESSION_SECRET: z.string().min(32).optional(),

  // ---- Onboarding Agent ---------------------------------------------------

  // Master toggle. The agent's routes and worker are only registered when
  // this is '1'. Lets us deploy the code dark and flip it on once Mux + AI
  // Gateway secrets are wired in the target environment.
  AGENT_ENABLED: z.string().optional(),

  // AI Gateway. Used by the agent loop (separate from ANTHROPIC_API_KEY,
  // which still backs the existing /ai/chat troubleshooter).
  AI_GATEWAY_API_KEY: z.string().optional(),
  // Override the primary agent model. Default: anthropic/claude-opus-4.7
  // routed via Vercel AI Gateway. The onboarding agent does open-ended
  // autonomous reasoning (folder triage, BOM inference, vision-on-photos)
  // where Opus's edge over Sonnet is real. Runs occasionally (per new
  // customer onboarding) so the cost stays bounded.
  // NOTE: Vercel uses dot-separated versions (claude-opus-4.7) not dash
  // (claude-opus-4-7) — the gateway provider rejects unknown IDs locally
  // without making an HTTP call, which surfaces as a confusing "No output
  // generated" error in the AI SDK.
  AGENT_MODEL: z.string().default('anthropic/claude-opus-4.7'),

  // HMAC secret for short-lived stream tokens (SSE auth). EventSource
  // can't set headers, so the propose/execute POST mints a token bound
  // to (runId, userId, purpose) for 5 minutes; the GET stream endpoint
  // validates it. Min 32 chars.
  STREAM_TOKEN_SECRET: z.string().min(32).optional(),

  // Mux. Required when AGENT_ENABLED=1 and videos are part of any run.
  MUX_TOKEN_ID: z.string().optional(),
  MUX_TOKEN_SECRET: z.string().optional(),
  MUX_WEBHOOK_SECRET: z.string().optional(),
  MUX_PLAYBACK_POLICY: z.enum(['public', 'signed']).default('public'),

  // Optional Slack incoming-webhook URL. When set, every /feedback POST
  // also pings this webhook so SANTECH gets real-time visibility during
  // the beta program without polling the DB. Submission still always
  // writes to the feedback table — Slack is just a sidecar.
  FEEDBACK_SLACK_WEBHOOK: optionalUrl,

  // Sentry DSN for error reporting. When unset, the SDK is initialized as
  // a no-op so local dev doesn't need an account. Set in Fly secrets for
  // production: `flyctl secrets set SENTRY_DSN=...`.
  SENTRY_DSN: optionalUrl,

  // Voice spend alarm Slack webhook. Optional. When set, the API fires a
  // one-shot daily ping per (org, UTC day) when an org crosses its
  // alertDailyDollarThreshold. Hard caps still apply regardless — this
  // is for visibility, not enforcement.
  VOICE_ALERT_SLACK_WEBHOOK: optionalUrl,
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
      // In production, refuse to start with a half-configured S3 — silently
      // falling back to the filesystem adapter would write uploads to a
      // container disk that disappears on the next deploy. In development
      // we want laptops with a partial .env to keep working — the FS
      // adapter is the dev default anyway.
      const message = `S3_BUCKET is set but missing required siblings: ${missing.join(', ')}`;
      if (env.NODE_ENV === 'production') {
        console.error(message);
        process.exit(1);
      }
      console.warn(`[env] ${message} — falling back to filesystem adapter (UPLOADS_DIR).`);
    }
  }
  if (env.AGENT_ENABLED === '1') {
    // STREAM_TOKEN_SECRET is required at boot — every SSE handshake mints
    // a token, so this would crash on the first request anyway.
    if (!env.STREAM_TOKEN_SECRET) {
      console.error('AGENT_ENABLED=1 requires STREAM_TOKEN_SECRET (32+ chars)');
      process.exit(1);
    }
    // AI_GATEWAY_API_KEY and MUX_* are checked at request time. Warn here
    // so the omission is visible, but don't block boot — that lets the
    // admin try the convention parser and review UI before all secrets
    // are wired.
    const missing: string[] = [];
    if (!env.AI_GATEWAY_API_KEY) missing.push('AI_GATEWAY_API_KEY');
    if (!env.MUX_TOKEN_ID) missing.push('MUX_TOKEN_ID');
    if (!env.MUX_TOKEN_SECRET) missing.push('MUX_TOKEN_SECRET');
    if (!env.MUX_WEBHOOK_SECRET) missing.push('MUX_WEBHOOK_SECRET');
    if (missing.length > 0) {
      console.warn(
        `[agent] AGENT_ENABLED=1 but missing optional secrets: ${missing.join(', ')}. ` +
          `LLM/Mux features will fail at request time until set.`,
      );
    }
  }
  return env;
}
