import { PgPool, parseDatabaseUrl, type Queryable } from './pg.ts';
import { config } from '../config.ts';

export const db = new PgPool({ ...parseDatabaseUrl(config.databaseUrl), max: config.dbPoolMax });
export type { Queryable };

/** First row or null. */
export async function one<T = any>(sql: string, params: unknown[] = [], q: Queryable = db): Promise<T | null> {
  const r = await q.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T = any>(sql: string, params: unknown[] = [], q: Queryable = db): Promise<T[]> {
  const r = await q.query<T>(sql, params);
  return r.rows;
}
