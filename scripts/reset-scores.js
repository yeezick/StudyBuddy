// Wipes the pre-FSRS mastery scores so /mastery starts from the DEC-056 formula alone:
// removes the stored `score` field from every card and deletes the weekly mastery snapshots
// (their module averages use the old formula). Card memory state (FSRS, SM-2), review
// events and quiz history are kept. Applies to Postgres and to the Redis rollback copy.
//
// Production Postgres is only reachable inside Railway, so run it there:
//
//   railway ssh -s studyagent -- node scripts/reset-scores.js --dry-run
//   railway ssh -s studyagent -- node scripts/reset-scores.js
//
// Both modes print the affected records first as one `[reset-scores] backup {…}` JSON line
// (the container's disk is not kept, so the backup is the output). A real run then writes,
// re-reads and exits 1 if anything is left. Re-running is safe: a clean store changes nothing.
//
// Needs SINGLE_USER_ID, DATABASE_URL and UPSTASH_REDIS_REST_URL/TOKEN.
import '../src/lib/env.js';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ownerConfig } from '../src/lib/config.js';

const parse = (raw) => (raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw);

async function scanKeys(redis, match) {
  const found = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.scan(cursor, { match, count: 1000 });
    found.push(...page);
    cursor = String(next);
  } while (cursor !== '0');
  return found.sort();
}

// What a real run would change, with the current values (the backup).
export async function plan({ pool, redis, userId }) {
  const pgCards = (await pool.query(
    `SELECT concept_id, state FROM cards WHERE user_id = $1 AND state ? 'score' ORDER BY concept_id`, [userId],
  )).rows.map((r) => ({ conceptId: r.concept_id, state: r.state }));
  const pgSnapshots = (await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, record FROM mastery_snapshots WHERE user_id = $1 ORDER BY day`, [userId],
  )).rows;

  const redisCards = [];
  for (const key of await scanKeys(redis, `mastery:${userId}:*`)) {
    const card = parse(await redis.get(key));
    if (card && typeof card === 'object' && 'score' in card) redisCards.push({ key, card });
  }
  const redisSnapshots = [];
  for (const key of await scanKeys(redis, `mastery-snapshot:${userId}:*`)) {
    redisSnapshots.push({ key, record: parse(await redis.get(key)) });
  }
  return { userId, pgCards, pgSnapshots, redisCards, redisSnapshots };
}

const counts = (p) => ({
  'postgres cards with score': p.pgCards.length,
  'postgres mastery_snapshots': p.pgSnapshots.length,
  'redis cards with score': p.redisCards.length,
  'redis mastery snapshots': p.redisSnapshots.length,
});
const total = (p) => Object.values(counts(p)).reduce((a, b) => a + b, 0);

export async function apply({ pool, redis, userId }, p) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE cards SET state = state - 'score', updated_at = now() WHERE user_id = $1 AND state ? 'score'`, [userId]);
    await client.query('DELETE FROM mastery_snapshots WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Redis is the rollback copy only (the app writes Postgres), so nothing races these writes.
  for (const { key, card } of p.redisCards) {
    const { score: _s, ...rest } = card;
    await redis.set(key, JSON.stringify(rest));
  }
  if (p.redisSnapshots.length) await redis.del(...p.redisSnapshots.map((s) => s.key));
}

// Returns the process exit code.
export async function main(argv, { env = process.env, pool, redis, log = console.log } = {}) {
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) { log(`[reset-scores] unknown argument(s): ${unknown.join(' ')}`); return 2; }
  const dryRun = argv.includes('--dry-run');
  const userId = ownerConfig(env).userId;
  if (!userId) { log('[reset-scores] Missing SINGLE_USER_ID.'); return 2; }
  if (!pool) { log('[reset-scores] Missing DATABASE_URL.'); return 2; }

  const before = await plan({ pool, redis, userId });
  log(`[reset-scores] user ${userId}`);
  for (const [what, n] of Object.entries(counts(before))) log(`  ${what}: ${n}`);
  log(`[reset-scores] backup ${JSON.stringify(before)}`);

  if (dryRun) { log('[reset-scores] dry run: nothing written'); return 0; }
  if (total(before) === 0) { log('[reset-scores] nothing to wipe'); return 0; }

  await apply({ pool, redis, userId }, before);
  const after = await plan({ pool, redis, userId });
  if (total(after) > 0) {
    log(`[reset-scores] FAILED: left after the run ${JSON.stringify(counts(after))}`);
    return 1;
  }
  log('[reset-scores] done: no stored scores or old snapshots left');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { redis } = await import('../src/redis.js');
  const url = process.env.DATABASE_URL;
  const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
  pool?.on('error', (err) => console.error(`[reset-scores] idle client error | ${err.message}`));
  try {
    process.exitCode = await main(process.argv.slice(2), { pool, redis });
  } catch (err) {
    console.error(`[reset-scores] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
