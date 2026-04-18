import { createDb } from './client';
import * as schema from './schema';
import { sql } from 'drizzle-orm';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const db = createDb(url);

const tables = [
  'organizations',
  'sites',
  'assetModels',
  'assetInstances',
  'qrCodes',
  'users',
  'memberships',
  'contentPacks',
] as const;

for (const t of tables) {
  const tbl = (schema as any)[t];
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(tbl);
  console.log(`${t}: ${row?.c ?? 0}`);
}
process.exit(0);
