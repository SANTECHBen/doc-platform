// Sentry initialization for the Fastify API. Idempotent and DSN-gated:
// no-op when SENTRY_DSN is unset, so dev environments don't need an
// account. Must be called BEFORE any application code that should be
// instrumented (i.e., very early in server.ts).

import * as Sentry from '@sentry/node';
import type { FastifyError, FastifyInstance } from 'fastify';

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
    // Defense-in-depth: scrub authorization/cookie/identity headers from
    // breadcrumbs and request data before they ship to Sentry. The Fastify
    // request body is already excluded below; this catches stray headers
    // that the Sentry SDK auto-captures.
    beforeSend(event) {
      try {
        if (event.request?.headers) {
          for (const k of Object.keys(event.request.headers)) {
            const lk = k.toLowerCase();
            if (
              lk === 'authorization' ||
              lk === 'cookie' ||
              lk === 'x-scan-session' ||
              lk === 'x-dev-user' ||
              lk === 'x-api-key'
            ) {
              event.request.headers[k] = '[REDACTED]';
            }
          }
        }
      } catch {
        // never let the scrubber itself break error delivery
      }
      return event;
    },
  });
  initialized = true;
}

export function attachSentryToFastify(
  app: FastifyInstance,
  env: { NODE_ENV: string },
): void {
  // Global error handler. Two jobs:
  //   1. (optional) ship to Sentry when initialized.
  //   2. Sanitize the response so we never echo a raw err.message back to
  //      the client on a 5xx — Postgres errors, file paths, API key
  //      fragments, and stack-derived strings have historically leaked
  //      this way. Client-facing 4xx still get the AppError message so
  //      validation feedback works.
  app.setErrorHandler((err, request, reply) => {
    const fastifyErr = err as FastifyError & { statusCode?: number };
    const status = fastifyErr.statusCode ?? 500;
    if (status >= 500) {
      if (initialized) {
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
      // Pino captures the full error with stack trace via Fastify's
      // default behavior. The client only sees a generic message — never
      // the raw err.message which may include DB strings, secrets, or
      // paths. In dev we keep the detail to make debugging easier.
      request.log.error(
        { err, reqId: request.id, method: request.method, url: request.url },
        'request failed with 5xx',
      );
      const rawMessage =
        err instanceof Error ? err.message : String(err);
      const safeMessage =
        env.NODE_ENV === 'production'
          ? 'Internal Server Error'
          : rawMessage || 'Internal Server Error';
      return reply.code(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        message: safeMessage,
        requestId: request.id,
      });
    }
    // 4xx — let Fastify's default formatter through (carries the original
    // message which is intended user feedback).
    reply.send(err);
  });
}

export { Sentry };
