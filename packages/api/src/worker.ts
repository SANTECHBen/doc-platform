// Extraction worker process. Runs separately from the API process so that
// the long-running, CPU-spiky, network-heavy work of pulling a doc through
// the extract → chunk → embed → save pipeline never competes with the
// API's HTTP event loop. The API just sets documents.extraction_status to
// 'pending'; this loop claims the next pending doc, runs it to completion,
// and repeats.
//
// Why a separate Node process and not worker_threads:
//   - Total isolation. A V8 OOM kill in the worker doesn't take down the
//     admin API (which would 502 the entire admin/PWA experience).
//   - Different VM size. The worker can be sized for the worst-case
//     LlamaParse upload while the API stays on a tight small box.
//   - Cleaner scaling story. Multiple worker machines can claim jobs from
//     the same Postgres-backed queue using SELECT … FOR UPDATE SKIP LOCKED.
//
// Why Postgres-as-queue and not Redis/SQS/Inngest:
//   - We already have Postgres. Zero new infra.
//   - SKIP LOCKED gives us correct multi-consumer semantics without a
//     separate broker.
//   - Latency is fine for this workload (3-5 min jobs; 3 s poll interval
//     vs. millisecond push doesn't matter).

import { sql } from 'drizzle-orm';
import { loadEnv } from './env';
import { createContext } from './context';
import { initSentry } from './sentry';
import { runExtraction } from './lib/extraction';

const env = loadEnv();
initSentry(env);
const ctx = createContext(env);

const POLL_INTERVAL_MS = 3_000;
const SHUTDOWN_GRACE_MS = 30_000;

let shuttingDown = false;
let inflight: Promise<void> | null = null;

function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level, time: Date.now(), pid: process.pid, ...data }));
}

// Crash-recovery sweep: reset 'processing' rows whose owning worker died
// mid-job. Worker boots are infrequent so this is cheap. Same idea as the
// API's boot sweep but it's owned by the worker now because the worker is
// what actually moves docs between 'pending' and 'processing'.
async function bootSweep(): Promise<number> {
  const result = await ctx.db.execute(
    sql`UPDATE documents
        SET extraction_status = 'pending', extraction_error = NULL
        WHERE extraction_status = 'processing'`,
  );
  return (result as unknown as { count?: number }).count ?? 0;
}

// Atomically claim the next pending doc. FOR UPDATE SKIP LOCKED lets us
// scale to multiple worker machines without coordination — each one
// only ever sees rows no peer is already processing.
async function claimNextJob(): Promise<string | null> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    UPDATE documents
    SET extraction_status = 'processing', extraction_error = NULL
    WHERE id = (
      SELECT id FROM documents
      WHERE extraction_status = 'pending'
      ORDER BY updated_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    let documentId: string | null = null;
    try {
      documentId = await claimNextJob();
    } catch (err) {
      log('error', { err: errorPayload(err), msg: 'claim query failed' });
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!documentId) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    log('info', { documentId, msg: 'claimed job' });
    inflight = runExtraction(
      { db: ctx.db, storage: ctx.storage, log: structuredLog },
      documentId,
    );
    try {
      await inflight;
    } catch (err) {
      // runExtraction is supposed to catch its own errors; this is
      // belt-and-suspenders so a thrown error doesn't kill the loop.
      log('error', { err: errorPayload(err), documentId, msg: 'extraction threw past runExtraction guard' });
    } finally {
      inflight = null;
    }
  }
}

const structuredLog = {
  info: (data: unknown, msg?: string) => log('info', toRecord(data, msg)),
  warn: (data: unknown, msg?: string) => log('warn', toRecord(data, msg)),
  error: (data: unknown, msg?: string) => log('error', toRecord(data, msg)),
};

function toRecord(data: unknown, msg?: string): Record<string, unknown> {
  if (typeof data === 'object' && data !== null) {
    return { ...data, msg };
  }
  return { data, msg };
}

function errorPayload(err: unknown): unknown {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', { signal, msg: 'shutdown requested' });
  if (inflight) {
    log('info', { msg: 'waiting for in-flight extraction to finish' });
    const timeout = sleep(SHUTDOWN_GRACE_MS).then(() => 'timeout');
    const winner = await Promise.race([inflight.then(() => 'done'), timeout]);
    log('info', { msg: `in-flight resolution: ${winner}` });
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

(async () => {
  try {
    const reset = await bootSweep();
    log('info', { reset, msg: 'boot sweep complete' });
  } catch (err) {
    log('warn', { err: errorPayload(err), msg: 'boot sweep failed; continuing' });
  }
  log('info', { pollIntervalMs: POLL_INTERVAL_MS, msg: 'worker loop starting' });
  await loop();
})().catch((err) => {
  log('error', { err: errorPayload(err), msg: 'worker loop crashed' });
  process.exit(1);
});
