import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgPool } from './pg.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate migrations both in source (server/db/migrations) and in the bundled build (dist/migrations). */
function migrationsDir() {
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations'), path.resolve('server/db/migrations')];
  return candidates.find((d) => fs.existsSync(d))!;
}

export async function migrate(pool: PgPool, log = console.log) {
  await pool.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // Serialize concurrent migrators (e.g. several app instances booting at once).
  const conn = await pool.acquire();
  try {
    await conn.query('SELECT pg_advisory_lock(727272)');
    const done = new Set((await conn.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir(), f), 'utf8');
      log(`[migrate] applying ${f}`);
      await conn.exec(`BEGIN;\n${sql}\n;INSERT INTO schema_migrations(name) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`).catch(async (e) => {
        await conn.exec('ROLLBACK').catch(() => {});
        throw e;
      });
    }
  } finally {
    await conn.query('SELECT pg_advisory_unlock(727272)').catch(() => {});
    pool.release(conn);
  }
}
