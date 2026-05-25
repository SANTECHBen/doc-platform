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
attachSentryToFastify(app, env);

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

// Search-index sweeper. Picks up procedure_steps / document_sections with
// search_index_stale_at > embedded_at, re-embeds them via Voyage, and
// clears the dirty bit. Runs every 60 seconds; concurrency cap is inside
// the indexer (sequential per-row). Guarded against double-start in
// dev/HMR by a global flag.
const SWEEPER_FLAG = Symbol.for('platform.search-sweeper');
const globalAny = globalThis as Record<symbol, unknown>;
if (!globalAny[SWEEPER_FLAG]) {
  globalAny[SWEEPER_FLAG] = true;
  const { reindexStale } = await import('@platform/ai');
  // Stagger the initial run so a cold boot doesn't race startup work.
  setTimeout(() => {
    const tick = async () => {
      try {
        const r = await reindexStale(ctx.db, 50);
        if (r.scanned > 0) {
          app.log.info(
            { ...r },
            'search-sweeper: re-embedded stale rows',
          );
        }
      } catch (err) {
        app.log.warn({ err }, 'search-sweeper: tick failed');
      }
    };
    void tick();
    setInterval(tick, 60_000);
  }, 15_000);
}

// Draft-run sweeper. Picks up procedure_draft_runs stuck in
// 'uploading' / 'transcribing' (waiting for a Mux webhook that never
// arrived) and polls Mux directly to advance them. Also fires the
// Whisper transcript fallback for drafts that have sat in
// 'transcribing' for >5 min — the in-process 5-minute timer in
// onDraftMuxAssetReady dies on container restart, this is the durable
// backup. See sweepStuckDrafts for details.
//
// Tick = 20s; sweepStuckDrafts only acts on drafts whose updatedAt is
// older than that, so the loop self-paces against Mux's API. Same
// global-symbol guard pattern as the search sweeper so dev HMR doesn't
// spawn parallel intervals.
const DRAFT_SWEEPER_FLAG = Symbol.for('platform.draft-sweeper');
if (!globalAny[DRAFT_SWEEPER_FLAG]) {
  globalAny[DRAFT_SWEEPER_FLAG] = true;
  const { sweepStuckDrafts } = await import('./services/draft-pipeline.js');
  setTimeout(() => {
    const tick = async () => {
      try {
        const r = await sweepStuckDrafts(app);
        if (r.scanned > 0 || r.errors > 0) {
          app.log.info({ ...r }, 'draft-sweeper: tick complete');
        }
      } catch (err) {
        app.log.warn({ err }, 'draft-sweeper: tick failed');
      }
    };
    void tick();
    setInterval(tick, 20_000);
  }, 10_000);
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
