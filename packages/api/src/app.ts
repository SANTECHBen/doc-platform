import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
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
import { registerFileRoutes } from './routes/files';
import { registerAdminAgent } from './routes/admin-agent';
import { registerAdminSections } from './routes/admin-sections';
import { registerProcedureRoutes } from './routes/procedures';
import { registerAdminProcedureSteps } from './routes/admin-procedure-steps';
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

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: { level: ctx.env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    // /files/* must be iframe-able from the PWA for PDF, video, and slides
    // rendering. The resource policy default (same-origin) also blocks that.
    frameguard: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, {
    origin: [ctx.env.PUBLIC_PWA_ORIGIN, ctx.env.PUBLIC_ADMIN_ORIGIN],
    credentials: true,
  });
  await app.register(sensible);
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
  await registerFileRoutes(app);
  await registerAIRoutes(app);
  await registerAdminAgent(app);
  await registerAdminSections(app);
  await registerProcedureRoutes(app);
  await registerAdminProcedureSteps(app);
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
