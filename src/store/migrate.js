import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 4_204_617; // any constant; serialises concurrent migrators

// Plain-SQL migrations: every NNN_name.sql in migrations/ runs once, in order, each in its
// own transaction, recorded in schema_migrations. Returns the versions applied this call.
export async function migrate(pool, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    const applied = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${err.message}`);
      }
      applied.push(version);
      log(`[store:migrate] applied ${version}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
