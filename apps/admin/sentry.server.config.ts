// Sentry server-side init for the admin Next.js process. No-op without DSN.

import * as Sentry from '@sentry/nextjs';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    release: process.env.NEXT_PUBLIC_APP_VERSION,
  });
}
