import { TEST_ENV } from './helpers/env.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { stubRedis } from './helpers/fakeRedis.js';
import { testDbEnabled, assertLocalTestDb } from './helpers/testDb.js';
import { redis } from '../src/redis.js';
import { migrate } from '../src/store/migrate.js';
import { main } from '../scripts/reset-scores.js';

const USER = TEST_ENV.SINGLE_USER_ID;
const ENV = { SINGLE_USER_ID: USER };

let fake;
beforeEach(() => { fake = stubRedis(); });
afterEach(() => fake.restore());

test('reset-scores refuses without a user, a database or with unknown flags', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(await main(['--dry-run'], { env: {}, redis, pool: {}, log }), 2);
  assert.equal(await main(['--dry-run'], { env: ENV, redis, pool: null, log }), 2);
  assert.equal(await main(['--force'], { env: ENV, redis, pool: {}, log }), 2);
});

if (!testDbEnabled()) {
  test('[postgres] reset-scores', { skip: process.env.CI ? false : 'TEST_POSTGRES unset' }, () => {
    assert.fail('TEST_POSTGRES is unset in CI — the reset-scores tests did not run');
  });
} else {
  assertLocalTestDb();
  const schema = `reset_test_${process.pid}`;
  let admin;
  let pool;

  before(async () => {
    admin = new pg.Pool({ max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ max: 4, options: `-c search_path=${schema}` });
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const fsrsCard = { conceptId: 'm1-c03', scheduler: 'fsrs', score: 0.3, stability: 1.05, state: 2, sm2: { repetitions: 2 }, nextReviewAt: '2026-10-05T20:09:18.995Z' };
  const cleanCard = { conceptId: 'm1-c04', scheduler: 'fsrs', stability: 3, state: 2, sm2: { repetitions: 1 } };

  async function seed() {
    await pool.query(`DROP SCHEMA ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    await migrate(pool, { log: () => {} });
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [USER, 'other-temp']);
    const insertCard = (user, id, state) => pool.query('INSERT INTO cards (user_id, concept_id, state) VALUES ($1, $2, $3)', [user, id, JSON.stringify(state)]);
    await insertCard(USER, 'ai-pm:m1-c03', fsrsCard);
    await insertCard(USER, 'ai-pm:m1-c04', cleanCard);
    await insertCard('other-temp', 'ai-pm:m1-c03', fsrsCard);
    await pool.query(`INSERT INTO mastery_snapshots (user_id, day, record) VALUES ($1, '2026-09-27', '{"avg":0.03}'), ($2, '2026-09-27', '{"avg":0.5}')`, [USER, 'other-temp']);

    const set = (k, v) => fake.store.set(k, JSON.stringify(v));
    set(`mastery:${USER}:m1-c03`, { conceptId: 'm1-c03', score: 0.15, easeFactor: 2.5, interval: 1, repetitions: 1 });
    set(`mastery:${USER}:m1-c04`, { conceptId: 'm1-c04', easeFactor: 2.5, interval: 1, repetitions: 0 });
    set(`mastery-snapshot:${USER}:2026-09-27`, { modules: [{ name: 'Module 1', avg: 0.03 }] });
    set(`mastery:other-temp:m1-c03`, { conceptId: 'm1-c03', score: 0.6 });
    set(`mastery-snapshot:other-temp:2026-09-27`, { modules: [] });
    set(`concepts:${USER}`, [{ id: 'm1-c03' }]);
  }

  const run = async (argv) => {
    const lines = [];
    const code = await main(argv, { env: ENV, redis, pool, log: (l) => lines.push(l) });
    return { code, lines, backup: JSON.parse(lines.find((l) => l.startsWith('[reset-scores] backup ')).slice(22)) };
  };
  const pgState = async () => ({
    cards: (await pool.query('SELECT user_id, concept_id, state FROM cards ORDER BY user_id, concept_id')).rows,
    snapshots: (await pool.query('SELECT user_id FROM mastery_snapshots ORDER BY user_id')).rows.map((r) => r.user_id),
  });

  test('[postgres] dry run prints counts and a full backup, and writes nothing', async () => {
    await seed();
    const pgBefore = JSON.stringify(await pgState());
    const redisBefore = JSON.stringify([...fake.store]);
    const { code, lines, backup } = await run(['--dry-run']);
    assert.equal(code, 0);
    assert.ok(lines.includes('  postgres cards with score: 1'), lines.join('\n'));
    assert.ok(lines.includes('  postgres mastery_snapshots: 1'));
    assert.ok(lines.includes('  redis cards with score: 1'));
    assert.ok(lines.includes('  redis mastery snapshots: 1'));
    assert.deepEqual(backup.pgCards, [{ conceptId: 'ai-pm:m1-c03', state: fsrsCard }]);
    assert.deepEqual(backup.pgSnapshots, [{ day: '2026-09-27', record: { avg: 0.03 } }]);
    assert.equal(backup.redisCards[0].card.score, 0.15);
    assert.equal(backup.redisSnapshots[0].key, `mastery-snapshot:${USER}:2026-09-27`);
    assert.equal(JSON.stringify(await pgState()), pgBefore);
    assert.equal(JSON.stringify([...fake.store]), redisBefore);
  });

  test('[postgres] real run drops only `score` and the snapshots, for the owner only; re-run is a no-op', async () => {
    await seed();
    assert.equal((await run([])).code, 0);

    const { cards, snapshots } = await pgState();
    const mine = cards.filter((c) => c.user_id === USER);
    const { score: _s, ...fsrsWithoutScore } = fsrsCard;
    assert.deepEqual(mine.map((c) => c.state), [fsrsWithoutScore, cleanCard], 'memory state kept, score gone');
    assert.equal(cards.find((c) => c.user_id === 'other-temp').state.score, 0.3, 'other users untouched');
    assert.deepEqual(snapshots, ['other-temp']);

    assert.deepEqual(JSON.parse(fake.store.get(`mastery:${USER}:m1-c03`)), { conceptId: 'm1-c03', easeFactor: 2.5, interval: 1, repetitions: 1 });
    assert.equal(fake.store.has(`mastery-snapshot:${USER}:2026-09-27`), false);
    assert.equal(JSON.parse(fake.store.get('mastery:other-temp:m1-c03')).score, 0.6);
    assert.ok(fake.store.has('mastery-snapshot:other-temp:2026-09-27'));
    assert.ok(fake.store.has(`concepts:${USER}`));

    const again = await run([]);
    assert.equal(again.code, 0);
    assert.ok(again.lines.includes('[reset-scores] nothing to wipe'));
  });
}
