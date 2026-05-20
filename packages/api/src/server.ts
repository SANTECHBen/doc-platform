import { sql } from 'drizzle-orm';
import { buildApp } from './app';
import { loadEnv } from './env';
import { createContext } from './context';
import { initSentry, attachSentryToFastify } from './sentry';
import { triggerExtraction } from './lib/extraction';

const env = loadEnv();
// Sentry must initialize BEFORE Fastify so the SDK can wire its diagnostic
// channels into the runtime. No-op when SENTRY_DSN is unset.
initSentry(env);
const ctx = createContext(env);
const app = await buildApp(ctx);
attachSentryToFastify(app);

// Crash-recovery sweep. The previous container may have died mid-extraction,
// leaving rows at extraction_status='processing' with no backing job. We
// also pick up any extraction_status='pending' rows — those are docs whose
// initial trigger fired against the prior container and got killed by the
// restart. Without this, the doc sits at "queued" forever in the admin UI
// (the Reprocess button only appears for failed/ready, so users had no way
// to unstick it short of a database write).
//
// 1) Reset stale 'processing' → 'pending'.
// 2) Re-fire triggerExtraction for every 'pending' doc.
//
// Idempotent: if the doc has no work to do, processDocument flips it to
// 'ready' or 'not_applicable' immediately. Capped at 200/boot so a stuck
// queue doesn't blow up startup time — anything beyond that can be cleaned
// up via the explicit /admin/.../reprocess endpoint.
try {
  await ctx.db.execute(
    sql`UPDATE documents
        SET extraction_status = 'pending', extraction_error = NULL
        WHERE extraction_status = 'processing'`,
  );
  const pending = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM documents
        WHERE extraction_status = 'pending'
        ORDER BY created_at DESC
        LIMIT 200`,
  );
  for (const row of pending) {
    triggerExtraction(app, row.id);
  }
  app.log.info(
    { reTriggered: pending.length },
    'extraction sweep complete',
  );
} catch (err) {
  app.log.warn({ err }, 'extraction sweep failed; continuing');
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
