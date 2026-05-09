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
// them to 'pending' so the admin UI can reprocess or they can be retried.
try {
  const result = await ctx.db.execute(
    sql`UPDATE documents
        SET extraction_status = 'pending', extraction_error = NULL
        WHERE extraction_status = 'processing'`,
  );
  // drizzle-orm/postgres-js returns a result with a 'count' field; different
  // versions expose it differently, so treat this purely informationally.
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
