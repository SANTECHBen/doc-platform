// Sentry client-side init. Auto-loaded by @sentry/nextjs in the browser.
// No-op when NEXT_PUBLIC_SENTRY_DSN is unset, so dev environments don't need
// a Sentry account to run.

import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
    // Sample 10% of perf traces to keep cost manageable during beta.
    tracesSampleRate: 0.1,
    // Session replay disabled — captures DOM and may include warehouse
    // photo content / customer-confidential markup. Enable later if a
    // beta participant explicitly opts in.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Beta-tagged release lets us filter dashboards by app version.
    release: process.env.NEXT_PUBLIC_APP_VERSION,
  });
}
