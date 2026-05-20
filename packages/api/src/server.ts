import { sql } from 'drizzle-orm';
import { buildApp } from './app';
import { loadEnv } from './env';
import { createContext } from './context';
import { initSentry, attachSentryToFastify } from './sentry';

const env = loadEnv();
// Sentry must initialize BEFORE Fastify so the SDK can wire its diagnostic
// channels into the runtime. No-op when SENTRY_DSN is unset.
initSentry(env);
const ctx = createContext(env);
const app = await buildApp(ctx);
attachSentryToFastify(app);

// Crash-recovery sweep. If a previous container died mid-extraction, any rows
// stuck at extraction_status='processing' have no process backing them. Reset
// them to 'pending' so the admin Reprocess button (now visible for 'pending'
// too) can retry on demand.
//
// We intentionally DO NOT auto-fire triggerExtraction here. Doing so caused
// an OOM-restart loop on small Fly machines when a large PDF was pending:
// boot → sweep → extract big PDF → OOM-kill → boot → repeat. User-driven
// reprocess is the safe retry path until extraction is hardened against
// large inputs.
try {
  const result = await ctx.db.execute(
    sql`UPDATE documents
        SET extraction_status = 'pending', extraction_error = NULL
        WHERE extraction_status = 'processing'`,
  );
  app.log.info({ sweepResult: (result as any).count ?? 'unknown' }, 'extraction sweep complete');
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
