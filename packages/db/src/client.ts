import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const sql = postgres(url, {
    max: 10,
    idle_timeout: 20,
    prepare: false,
  });
  return drizzle(sql, { schema, casing: 'snake_case' });
}
