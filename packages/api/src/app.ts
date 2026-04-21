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
import { registerFileRoutes } from './routes/files';

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
  await registerFileRoutes(app);
  await registerAIRoutes(app);

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
