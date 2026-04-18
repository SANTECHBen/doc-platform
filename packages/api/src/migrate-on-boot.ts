// Runs Drizzle migrations automatically before the server starts. Invoked from
// `start:prod` so every deploy is self-migrating. Safe to run repeatedly — the
// migration tracker is idempotent.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required to run migrations.');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

// Resolve the drizzle folder inside the @platform/db package, which ships with
// the container alongside this API package.
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../db/drizzle');

console.log(`[boot] applying migrations from ${migrationsFolder}`);
try {
  await migrate(db, { migrationsFolder });
  console.log('[boot] migrations complete');
} catch (err) {
  console.error('[boot] migration failed', err);
  process.exit(1);
} finally {
  await sql.end();
}
