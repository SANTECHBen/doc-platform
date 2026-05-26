import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { AppContext } from './context';
import { registerAuth } from './middleware/auth';
import { registerScanSession } from './middleware/scan-session';
import { registerAssetRoutes } from './routes/assets';
import { registerContentRoutes } from './routes/content';
import { registerAIRoutes } from './routes/ai';
import { registerHealthRoutes } from './routes/health';
import { registerTrainingRoutes } from './routes/training';
import { registerPartsRoutes } from './routes/parts';
import {
  registerAdminRoutes,
  registerAdminListings,
  registerAdminMutations,
  registerAdminAuthoring,
  registerAdminTrainingAuthoring,
} from './routes/admin';
import { registerWorkOrderRoutes } from './routes/workorders';
import { registerQrTemplateRoutes } from './routes/qr-templates';
import { registerQrDesignRoutes } from './routes/qr-designs';
import { registerFileRoutes } from './routes/files';
import { registerAdminAgent } from './routes/admin-agent';
import { registerAdminSections } from './routes/admin-sections';
import { registerProcedureRoutes } from './routes/procedures';
import { registerAdminProcedureSteps } from './routes/admin-procedure-steps';
import { registerAdminProcedureStepCategories } from './routes/admin-procedure-step-categories';
import { registerAdminSnippets } from './routes/admin-snippets';
import { registerAdminSnippetAudioRoutes } from './routes/admin-snippet-audio';
import { registerSearchRoutes } from './routes/search';
import { registerAdminProcedureDrafts } from './routes/admin-procedure-drafts';
import { registerPwaProcedureDrafts } from './routes/pwa-procedure-drafts';
import { registerFieldProcedureRoutes } from './routes/field-procedures';
import { registerFeedbackRoutes } from './routes/feedback';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerVoiceRoutes } from './routes/voice';
import { registerPreflightRoutes } from './routes/preflight';
import { registerAdminVoiceUsageRoutes } from './routes/admin-voice-usage';
import { registerAdminProcedureAudioRoutes } from './routes/admin-procedure-audio';
import { registerAdminPromoteRoutes } from './routes/admin-promote';
import { registerAdminDocumentMoveRoutes } from './routes/admin-document-move';
import { registerAdminProcedureDuplicate } from './routes/admin-procedure-duplicate';
import { registerMeRoutes } from './routes/me';
import { registerAdminPm } from './routes/admin-pm';
import { registerAdminPmPlans } from './routes/admin-pm-plans';
import { registerAdminTroubleshooting } from './routes/admin-troubleshooting';
import { registerPmRoutes } from './routes/pm';
import { registerMuxPlaybackRoutes } from './routes/mux-playback';
import { registerAdminSlideCourses } from './routes/admin-slide-courses';
import { registerSlideCoursePlayerRoutes } from './routes/slide-course-player';
import { registerSlideCourseScanRoutes } from './routes/slide-course-scan';
import { registerAdminScormCourses } from './routes/admin-scorm-courses';

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: {
      level: ctx.env.NODE_ENV === 'production' ? 'info' : 'debug',
      // Redact authentication and identity headers before they hit log
      // aggregation (Pino) or Sentry breadcrumbs. Without this, a single
      // request.log.info({ headers }) call would surface live bearer tokens
      // and HMAC-signed scan-session cookies into the operator's log
      // pipeline. The redact paths cover both the wire format (bracket-
      // notation header names) and common nested-object shapes.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-scan-session"]',
          'req.headers["x-dev-user"]',
          'req.headers["x-api-key"]',
          'request.headers.authorization',
          'request.headers.cookie',
          'request.headers["x-scan-session"]',
          'request.headers["x-dev-user"]',
          'headers.authorization',
          'headers.cookie',
          // Common keys when secrets sneak into logged objects.
          '*.idToken',
          '*.id_token',
          '*.accessToken',
          '*.access_token',
          '*.refreshToken',
          '*.refresh_token',
          '*.password',
          '*.secret',
          '*.apiKey',
          '*.api_key',
        ],
        censor: '[REDACTED]',
      },
    },
    // Trust the immediate proxy hop only — Fly's edge sets X-Forwarded-*
    // headers, and we should NOT trust the entire chain (would let
    // attackers spoof their source IP into our audit log by adding their
    // own X-Forwarded-For). Numeric value = "trust N proxies in front".
    trustProxy: 1,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Helmet with strict defaults globally; the /files/* prefix needs the
  // relaxations (iframe-able PDFs, cross-origin embeds) but the JSON API
  // surface does not. Per-route relaxation is registered separately below.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    // X-Frame-Options on every JSON endpoint (only /files/* is iframe-able).
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginEmbedderPolicy: false, // breaks third-party fetches we depend on
    strictTransportSecurity:
      ctx.env.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
  });
  // Per-route helmet relaxation for /files/* — those responses must be
  // iframe-able from the PWA + admin origins for PDF, image, and audio
  // preview. Re-register a relaxed instance scoped to the prefix.
  app.register(async (scope) => {
    await scope.register(helmet, {
      contentSecurityPolicy: false,
      frameguard: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    });
  }, { prefix: '/files' });
  await app.register(cors, {
    // Defensive guard: an env var set to '*' or empty would otherwise pass
    // straight through to @fastify/cors. Reject obvious mistakes and pin
    // to explicit origins.
    origin: (() => {
      const origins = [ctx.env.PUBLIC_PWA_ORIGIN, ctx.env.PUBLIC_ADMIN_ORIGIN]
        .filter((o): o is string => typeof o === 'string' && o.length > 0)
        .filter((o) => o !== '*' && !o.includes('*'));
      if (origins.length === 0) {
        throw new Error(
          'CORS origins are required — set PUBLIC_PWA_ORIGIN and PUBLIC_ADMIN_ORIGIN to explicit URLs.',
        );
      }
      return origins;
    })(),
    credentials: true,
  });
  await app.register(sensible);
  // Global rate limit. Keyed by authenticated user when present, otherwise
  // by client IP. The default is generous (300 req/min) so legitimate UI
  // traffic stays fast; per-route overrides clamp the cost-of-goods
  // endpoints (chat, search, AI uploads) much more aggressively. The
  // in-memory store works for single-instance Fly; when we scale wide,
  // swap in @fastify/rate-limit's Redis store via the `redis` option.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) =>
      req.auth?.userId ??
      req.scanSession?.qrCode ??
      (req.ip ?? 'unknown'),
    // Health checks and the Mux webhook (HMAC-verified) shouldn't be
    // rate-limited; they have their own validation surface.
    allowList: (req) => {
      const url = req.url ?? '';
      return (
        url === '/health' ||
        url === '/healthz' ||
        url.startsWith('/admin/webhooks/mux')
      );
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Slow down and try again in a moment.',
      retryAfterSec: Math.ceil(context.ttl / 1000),
    }),
  });
  await app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024, // 2 GB — rugby tape for big OEM videos
      files: 1,
    },
  });

  app.decorate('ctx', ctx);

  await registerAuth(app);
  await registerScanSession(app);
  await registerHealthRoutes(app);
  await registerAssetRoutes(app);
  await registerContentRoutes(app);
  await registerTrainingRoutes(app);
  await registerPartsRoutes(app);
  await registerAdminRoutes(app);
  await registerAdminListings(app);
  await registerAdminMutations(app);
  await registerAdminAuthoring(app);
  await registerAdminTrainingAuthoring(app);
  await registerWorkOrderRoutes(app);
  await registerQrTemplateRoutes(app);
  await registerQrDesignRoutes(app);
  await registerFileRoutes(app);
  await registerAIRoutes(app);
  await registerAdminAgent(app);
  await registerAdminSections(app);
  await registerProcedureRoutes(app);
  await registerAdminProcedureSteps(app);
  await registerAdminProcedureStepCategories(app);
  await registerAdminSnippets(app);
  await registerAdminSnippetAudioRoutes(app);
  await registerSearchRoutes(app);
  await registerAdminProcedureDrafts(app);
  await registerPwaProcedureDrafts(app);
  await registerFieldProcedureRoutes(app);
  await registerFeedbackRoutes(app);
  await registerAnalyticsRoutes(app);
  await registerVoiceRoutes(app);
  await registerPreflightRoutes(app);
  await registerAdminVoiceUsageRoutes(app);
  await registerAdminProcedureAudioRoutes(app);
  await registerAdminPromoteRoutes(app);
  await registerAdminDocumentMoveRoutes(app);
  await registerAdminProcedureDuplicate(app);
  await registerMeRoutes(app);
  await registerAdminPm(app);
  await registerAdminPmPlans(app);
  await registerAdminTroubleshooting(app);
  await registerPmRoutes(app);
  await registerMuxPlaybackRoutes(app);
  await registerAdminSlideCourses(app);
  await registerSlideCoursePlayerRoutes(app);
  await registerSlideCourseScanRoutes(app);
  await registerAdminScormCourses(app);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth?: {
      userId: string;
      organizationId: string;
      /** True for SANTECH staff — bypasses per-org data scoping. */
      platformAdmin?: boolean;
    };
    /** Populated by scan-session middleware when a valid X-Scan-Session
     *  header is present. Represents anonymous, QR-scoped authorization —
     *  weaker than auth, narrower than a user's org tree. */
    scanSession?: {
      qrCode: string;
      assetInstanceId: string;
      organizationId: string;
    };
  }
}
