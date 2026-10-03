// Copies production records from Redis into Postgres (Brief T2, design §10 slice 3).
// Redis is only read: it stays as the rollback. Run with the deployment's env, e.g.
//
//   railway run node scripts/migrate-redis-to-postgres.js --dry-run
//
// Modes (one of):
//   --dry-run   read Redis, print rows per table and every record it can't map; write nothing
//   (none)      apply pending migrations, then copy; idempotent (re-running changes nothing)
//   --verify    compare Redis and Postgres through the store interface; exit 1 on any mismatch
// Options:
//   --user <id> migrate this user too (repeatable). Default: the owner (SINGLE_USER_ID) only.
//
// Needs UPSTASH_REDIS_REST_URL/TOKEN, SINGLE_USER_ID and DATABASE_URL (optional for --dry-run).
// A real run refuses when STORE_BACKEND=postgres: the app already writes to Postgres, and
// copying Redis over it would overwrite newer data.
import '../src/lib/env.js';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ownerConfig } from '../src/lib/config.js';
import { migrate } from '../src/store/migrate.js';
import { TABLES, readRedis, planCounts, postgresCounts, writeUser, verify } from '../src/store/redisToPostgres.js';

export function parseArgs(argv) {
  const opts = { mode: 'run', users: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.mode = opts.mode === 'run' ? 'dry-run' : 'conflict';
    else if (a === '--verify') opts.mode = opts.mode === 'run' ? 'verify' : 'conflict';
    else if (a === '--user' && argv[i + 1]) opts.users.push(argv[++i]);
    else throw new Error(`unknown argument "${a}"`);
  }
  if (opts.mode === 'conflict') throw new Error('use one of --dry-run or --verify');
  return opts;
}

function table(rows, log) {
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(width[i])).join('  ');
  log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  rows.forEach((r) => log(line(r)));
}

// Returns the process exit code.
export async function main(argv, { env = process.env, redis, pool, log = console.log } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) { log(`[migrate] ${err.message}`); return 2; }

  const primaryUserId = ownerConfig(env).userId;
  if (!primaryUserId) { log('[migrate] Missing SINGLE_USER_ID.'); return 2; }
  const userIds = [...new Set([primaryUserId, ...opts.users])];
  if (opts.mode === 'run' && env.STORE_BACKEND === 'postgres') {
    log('[migrate] STORE_BACKEND=postgres: the app already writes to Postgres. Refusing to copy Redis over it.');
    return 2;
  }
  if (!pool && opts.mode !== 'dry-run') { log('[migrate] Missing DATABASE_URL.'); return 2; }

  if (opts.mode === 'verify') {
    const mismatches = await verify({ redis, pool, userIds, primaryUserId });
    for (const m of mismatches) {
      const detail = m.what.startsWith('count') || m.what === 'schema' ? ` redis=${m.redis} postgres=${m.postgres}` : '';
      log(`[verify] MISMATCH ${m.userId} · ${m.what}${detail}`);
    }
    log(mismatches.length ? `[verify] FAILED: ${mismatches.length} mismatch(es)` : `[verify] OK: Postgres matches Redis for ${userIds.join(', ')}`);
    return mismatches.length ? 1 : 0;
  }

  const { users, otherUsers, redisOnlyKeys, unmapped } = await readRedis(redis, { userIds, primaryUserId });

  for (const userId of userIds) {
    const plan = users[userId];
    const before = pool ? await postgresCounts(pool, userId, plan.topicId) : null;
    const want = planCounts(plan);
    log(`\n[migrate] user ${userId} → topic ${plan.topicId}`);
    table(TABLES.map((t) => ({ table: t, redis: want[t], postgres_now: before ? before[t] : before === null && pool ? 'no schema' : '-' })), log);
    if (plan.reviewEvents) log(`[migrate] ${plan.reviewEvents} review event(s) in Redis: not migrated (slice 4)`);
  }
  log(`\n[migrate] Redis-only keys left in place (queues, quizzes): ${redisOnlyKeys}`);
  for (const [u, n] of Object.entries(otherUsers)) log(`[migrate] not migrated: user ${u} (${n} key(s)); pass --user ${u} to include`);
  log(`[migrate] records it can't map: ${unmapped.length}`);
  for (const { key, reason } of unmapped) log(`  - ${key}: ${reason}`);

  if (opts.mode === 'dry-run') { log('\n[migrate] dry run: nothing written'); return 0; }
  if (unmapped.length) { log('\n[migrate] refusing to write while records can\'t be mapped. Fix them or report them first.'); return 1; }

  const applied = await migrate(pool, { log: () => {} });
  if (applied.length) log(`[migrate] applied schema migrations: ${applied.join(', ')}`);
  for (const userId of userIds) {
    await writeUser(pool, userId, users[userId]);
    const after = await postgresCounts(pool, userId, users[userId].topicId);
    log(`[migrate] wrote ${userId}: ${TABLES.map((t) => `${t}=${after[t]}`).join(' ')}`);
  }
  log('[migrate] done. Next: --verify');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { redis } = await import('../src/redis.js');
  const url = process.env.DATABASE_URL;
  const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
  pool?.on('error', (err) => console.error(`[migrate] idle client error | ${err.message}`));
  try {
    process.exitCode = await main(process.argv.slice(2), { redis, pool });
  } catch (err) {
    console.error(`[migrate] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
