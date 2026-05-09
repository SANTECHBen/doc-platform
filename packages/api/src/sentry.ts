// Sentry initialization for the Fastify API. Idempotent and DSN-gated:
// no-op when SENTRY_DSN is unset, so dev environments don't need an
// account. Must be called BEFORE any application code that should be
// instrumented (i.e., very early in server.ts).

import * as Sentry from '@sentry/node';
import type { FastifyInstance } from 'fastify';

let initialized = false;

export function initSentry(env: { SENTRY_DSN?: string; NODE_ENV: string }): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.1,
    // Don't auto-capture console.log — too noisy. Errors and unhandled
    // promise rejections still flow through.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'Console'),
  });
  initialized = true;
}

export function attachSentryToFastify(app: FastifyInstance): void {
  if (!initialized) return;

  // Capture all 5xx as Sentry errors. Fastify already logs them via Pino,
  // so this is purely the alerting/tracking pipeline.
  app.setErrorHandler((err, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      Sentry.captureException(err, {
        contexts: {
          request: {
            method: request.method,
            url: request.url,
            // Don't send request body — likely contains user-uploaded
            // text or other sensitive content.
          },
        },
      });
    }
    // Fastify's default error formatter still runs; Sentry capture is sidecar.
    reply.send(err);
  });
}

export { Sentry };
