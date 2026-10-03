// Applies pending Postgres migrations (src/store/migrations/*.sql) to DATABASE_URL.
// The app also runs them on boot when STORE_BACKEND=postgres; this is for doing it by hand.
//
//   DATABASE_URL=postgres://... node scripts/db-migrate.js
import '../src/lib/env.js';
import pg from 'pg';
import { migrate } from '../src/store/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db-migrate] Missing DATABASE_URL.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `[db-migrate] applied ${applied.join(', ')}` : '[db-migrate] up to date');
} catch (err) {
  console.error(`[db-migrate] ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
