// Sentry client-side init. Auto-loaded by @sentry/nextjs in the browser.
// No-op when NEXT_PUBLIC_SENTRY_DSN is unset.

import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    release: process.env.NEXT_PUBLIC_APP_VERSION,
  });
}
