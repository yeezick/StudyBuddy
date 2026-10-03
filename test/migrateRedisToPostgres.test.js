import { TEST_ENV } from './helpers/env.js';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { stubRedis } from './helpers/fakeRedis.js';
import { testDbEnabled, assertLocalTestDb } from './helpers/testDb.js';
import { redis } from '../src/redis.js';
import { migrate } from '../src/store/migrate.js';
import { classifyKey, readOnly, readRedis, planCounts, postgresCounts, verify } from '../src/store/redisToPostgres.js';
import { main, parseArgs } from '../scripts/migrate-redis-to-postgres.js';

const USER = TEST_ENV.SINGLE_USER_ID;
const ENV = { SINGLE_USER_ID: USER };
const quiet = () => {};

const concept = (id, extra = {}) => ({
  id, name: `Name ${id}`, summary: `Summary ${id}`, scope: { module: 'Module 1', moduleLabel: 'Getting Started', lesson: 'L1' }, tags: ['a'], ...extra,
});
const card = (conceptId, extra = {}) => ({
  conceptId, easeFactor: 2.5, interval: 6, repetitions: 2, nextReviewAt: '2026-10-10T13:30:00.000Z', lastScore: 4, ...extra,
});
const historyEntry = (n) => ({ quizId: `q${n}`, completedAt: `2026-10-0${n}T14:00:00.000Z`, score: n, total: 5 });

// Production-shaped Redis: values are stored as JSON text, lists newest first.
function seedRedis(fake, { user = USER } = {}) {
  const set = (k, v) => fake.store.set(k, JSON.stringify(v));
  set(`concepts:${user}`, [concept('m1-c01'), concept('m1-c02'), concept('m2-c01', { tags: [] })]);
  set(`mastery:${user}:m1-c01`, card('m1-c01'));
  set(`mastery:${user}:m1-c02`, card('m1-c02', { nextReviewAt: null }));
  set(`mastery:${user}:old-c09`, card('old-c09')); // card outliving its concept
  set(`session:${user}`, { sessionId: `s-${user}`, status: 'completed', startedAt: '2026-10-01T15:00:00.000Z', completedAt: '2026-10-01T15:45:00.000Z', segments: [{ n: 1 }] });
  set(`settings:${user}`, { quietHours: [22, 7] });
  set(`mastery-snapshot:${user}:2026-09-27`, { day: '2026-09-27', avg: 41 });
  set(`mastery-snapshot:${user}:2026-10-04`, { day: '2026-10-04', avg: 55 });
  // Newest first, with a genuine duplicate.
  fake.lists.set(`history:${user}`, [historyEntry(3), historyEntry(2), historyEntry(2), historyEntry(1)].map((e) => JSON.stringify(e)));
  // Stay in Redis.
  set('quiz:q9', { quizId: 'q9' });
  fake.store.set(`active-quiz:${user}`, 'q9');
  fake.store.set('bull:scheduler:meta', 'x');
}

const snapshotOf = (fake) => JSON.stringify([[...fake.store], [...fake.lists]]);

let fake;
beforeEach(() => { fake = stubRedis(); });
afterEach(() => fake.restore());

test('classifyKey maps every record key and leaves queues/quizzes in Redis', () => {
  assert.deepEqual(classifyKey('concepts:u1'), { kind: 'concepts', userId: 'u1' });
  assert.deepEqual(classifyKey('mastery:u1:m1-c01'), { kind: 'card', userId: 'u1', sub: 'm1-c01' });
  assert.deepEqual(classifyKey('mastery:team:u1:m1-c01'), { kind: 'card', userId: 'team:u1', sub: 'm1-c01' });
  assert.deepEqual(classifyKey('mastery-snapshot:u1:2026-10-01'), { kind: 'snapshot', userId: 'u1', sub: '2026-10-01' });
  assert.equal(classifyKey('quiz:abc').kind, 'redisOnly');
  assert.equal(classifyKey('active-quiz:u1').kind, 'redisOnly');
  assert.equal(classifyKey('bull:q:1').kind, 'redisOnly');
  assert.equal(classifyKey('mastery:u1').kind, 'unmapped');
  assert.equal(classifyKey('concepts:').kind, 'unmapped');
  assert.equal(classifyKey('something-else').kind, 'unmapped');
});

test('readRedis maps every record of the owner and only reads', async () => {
  seedRedis(fake);
  fake.lists.set(`review-events:${USER}`, ['{}', '{}']);
  seedRedis(fake, { user: 'someone-temp' });
  const before = snapshotOf(fake);

  const { users, otherUsers, redisOnlyKeys, unmapped } = await readRedis(redis, { userIds: [USER], primaryUserId: USER });
  const plan = users[USER];

  assert.equal(snapshotOf(fake), before, 'Redis must be untouched');
  assert.deepEqual(unmapped, []);
  assert.equal(plan.topicId, 'ai-pm');
  assert.deepEqual(planCounts(plan), { users: 1, topics: 1, concepts: 3, cards: 3, quiz_history: 4, sessions: 1, mastery_snapshots: 2 });
  assert.deepEqual(plan.concepts.map((c) => c.id), ['m1-c01', 'm1-c02', 'm2-c01'], 'library order kept');
  assert.deepEqual(plan.history.map((e) => e.quizId), ['q1', 'q2', 'q2', 'q3'], 'oldest first');
  assert.deepEqual(plan.settings, { quietHours: [22, 7] });
  assert.equal(plan.reviewEvents, 2);
  assert.equal(redisOnlyKeys, 4, 'quiz, bull and both active-quiz pointers');
  assert.equal(otherUsers['someone-temp'], 9, 'other users are reported, not migrated');
});

test('readRedis reports every record it cannot map', async () => {
  const set = (k, v) => fake.store.set(k, JSON.stringify(v));
  set(`concepts:${USER}`, [concept('m1-c01'), { name: 'no id' }, concept('m1-c01')]);
  set(`mastery:${USER}:m1-c01`, card('m1-c02'));
  set(`mastery:${USER}:m1-c03`, card('m1-c03', { nextReviewAt: 1760000000000 }));
  set(`mastery-snapshot:${USER}:yesterday`, { avg: 1 });
  set(`session:${USER}`, { status: 'active' });
  set(`settings:${USER}`, [1, 2]);
  fake.lists.set(`history:${USER}`, ['"just a string"', JSON.stringify(historyEntry(1))]);
  fake.store.set('stray-key', 'x');

  const { users, unmapped } = await readRedis(redis, { userIds: [USER], primaryUserId: USER });
  const reasons = Object.fromEntries(unmapped.map((u) => [u.key, u.reason]));

  assert.match(reasons[`concepts:${USER}[1]`], /without an id/);
  assert.match(reasons[`concepts:${USER}[2]`], /duplicate concept id m1-c01/);
  assert.match(reasons[`mastery:${USER}:m1-c01`], /does not match its key/);
  assert.match(reasons[`mastery:${USER}:m1-c03`], /not a timestamp/);
  assert.match(reasons[`mastery-snapshot:${USER}:yesterday`], /YYYY-MM-DD/);
  assert.match(reasons[`session:${USER}`], /sessionId/);
  assert.match(reasons[`settings:${USER}`], /not an object/);
  assert.match(reasons[`history:${USER}[0]`], /not an object/);
  assert.match(reasons['stray-key'], /unknown key pattern/);
  assert.equal(unmapped.length, 9);
  assert.deepEqual(planCounts(users[USER]), { users: 1, topics: 1, concepts: 1, cards: 0, quiz_history: 1, sessions: 0, mastery_snapshots: 0 });
});

test('readOnly lets reads through and throws on any write', async () => {
  const ro = readOnly(redis);
  fake.store.set('k', '"v"');
  assert.equal(await ro.get('k'), 'v');
  assert.throws(() => ro.set('k', 'x'), /read-only/);
  assert.throws(() => ro.del('k'), /read-only/);
  assert.throws(() => ro.lpush('l', 'x'), /read-only/);
});

test('parseArgs accepts one mode and repeatable --user', () => {
  assert.deepEqual(parseArgs([]), { mode: 'run', users: [] });
  assert.deepEqual(parseArgs(['--dry-run', '--user', 'u2', '--user', 'u3']), { mode: 'dry-run', users: ['u2', 'u3'] });
  assert.equal(parseArgs(['--verify']).mode, 'verify');
  assert.throws(() => parseArgs(['--dry-run', '--verify']), /one of/);
  assert.throws(() => parseArgs(['--delete']), /unknown argument/);
});

test('main --dry-run without a database prints counts and writes nothing', async () => {
  seedRedis(fake);
  const before = snapshotOf(fake);
  const lines = [];
  assert.equal(await main(['--dry-run'], { env: ENV, redis, pool: null, log: (l) => lines.push(l) }), 0);
  const out = lines.join('\n');
  assert.match(out, /concepts\s+3/);
  assert.match(out, /quiz_history\s+4/);
  assert.match(out, /records it can't map: 0/);
  assert.match(out, /dry run: nothing written/);
  assert.equal(snapshotOf(fake), before);
});

test('main refuses a real run when the app already uses Postgres, or without a database', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(await main([], { env: { ...ENV, STORE_BACKEND: 'postgres' }, redis, pool: {}, log }), 2);
  assert.match(lines.join('\n'), /Refusing/);
  assert.equal(await main([], { env: ENV, redis, pool: null, log }), 2);
  assert.equal(await main(['--verify'], { env: ENV, redis, pool: null, log }), 2);
  assert.equal(await main(['--dry-run'], { env: {}, redis, pool: null, log }), 2, 'needs SINGLE_USER_ID');
});

if (!testDbEnabled()) {
  test('[postgres] redis → postgres migration', { skip: process.env.CI ? false : 'TEST_POSTGRES unset' }, () => {
    assert.fail('TEST_POSTGRES is unset in CI — the migration tests did not run');
  });
} else {
  assertLocalTestDb();
  const schema = `t2_test_${process.pid}`;
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

  // Each test starts from an empty, unmigrated schema.
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  });

  const run = (argv, env = ENV) => main(argv, { env, redis, pool, log: quiet });

  test('[postgres] dry run reports a missing schema and creates nothing', async () => {
    seedRedis(fake);
    const lines = [];
    assert.equal(await main(['--dry-run'], { env: ENV, redis, pool, log: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /no schema/);
    assert.equal(await postgresCounts(pool, USER, 'ai-pm'), null);
  });

  test('[postgres] real run migrates the schema, copies every table and verifies', async () => {
    seedRedis(fake);
    const before = snapshotOf(fake);
    assert.equal(await run([]), 0);
    assert.equal(snapshotOf(fake), before, 'Redis must be untouched');

    assert.deepEqual(await postgresCounts(pool, USER, 'ai-pm'),
      { users: 1, topics: 1, concepts: 3, cards: 3, quiz_history: 4, sessions: 1, mastery_snapshots: 2 });
    const { rows: concepts } = await pool.query('SELECT id, local_id, unit, lesson, tags, position, provenance FROM concepts ORDER BY position');
    assert.deepEqual(concepts.map((r) => [r.id, r.position]), [['ai-pm:m1-c01', 0], ['ai-pm:m1-c02', 1], ['ai-pm:m2-c01', 2]]);
    assert.deepEqual([concepts[0].unit, concepts[0].lesson, concepts[0].tags], ['Module 1', 'L1', ['a']]);
    assert.deepEqual(concepts[2].tags, []);
    assert.equal(concepts[0].provenance.addedBy, 'redis-migration');
    const { rows: cards } = await pool.query('SELECT concept_id, due FROM cards ORDER BY concept_id');
    assert.deepEqual(cards.map((r) => [r.concept_id, r.due?.toISOString() ?? null]),
      [['ai-pm:m1-c01', '2026-10-10T13:30:00.000Z'], ['ai-pm:m1-c02', null], ['ai-pm:old-c09', '2026-10-10T13:30:00.000Z']]);

    assert.deepEqual(await verify({ redis, pool, userIds: [USER], primaryUserId: USER }), []);
    assert.equal(await run(['--verify']), 0);
  });

  test('[postgres] re-running is idempotent and keeps genuine duplicates', async () => {
    seedRedis(fake);
    assert.equal(await run([]), 0);
    const first = await postgresCounts(pool, USER, 'ai-pm');
    assert.equal(await run([]), 0);
    assert.deepEqual(await postgresCounts(pool, USER, 'ai-pm'), first);
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM quiz_history WHERE entry->>'quizId' = 'q2'");
    assert.equal(rows[0].n, 2);
    assert.equal(await run(['--verify']), 0);
  });

  test('[postgres] a re-run picks up new Redis writes made before the switch', async () => {
    seedRedis(fake);
    assert.equal(await run([]), 0);
    fake.lists.get(`history:${USER}`).unshift(JSON.stringify(historyEntry(4)));
    fake.store.set(`mastery:${USER}:m1-c01`, JSON.stringify(card('m1-c01', { interval: 15 })));
    assert.equal(await run(['--verify']), 1, 'verify sees Redis moved on');
    assert.equal(await run([]), 0);
    assert.equal(await run(['--verify']), 0);
    assert.equal((await postgresCounts(pool, USER, 'ai-pm')).quiz_history, 5);
  });

  test('[postgres] verify fails on a changed value, a missing row or an extra row', async () => {
    seedRedis(fake);
    assert.equal(await run([]), 0);

    await pool.query(`UPDATE concepts SET data = jsonb_set(data, '{summary}', '"tampered"') WHERE id = 'ai-pm:m1-c02'`);
    let m = await verify({ redis, pool, userIds: [USER], primaryUserId: USER });
    assert.deepEqual(m.map((x) => x.what), ['concepts']);

    await run([]); // repairs it
    await pool.query("DELETE FROM mastery_snapshots WHERE day = '2026-09-27'");
    await pool.query(`INSERT INTO cards (user_id, concept_id, state) VALUES ($1, 'ai-pm:m9-c09', '{"conceptId":"m9-c09"}')`, [USER]);
    m = await verify({ redis, pool, userIds: [USER], primaryUserId: USER });
    assert.deepEqual(m.map((x) => x.what).sort(), ['count cards', 'count mastery_snapshots', 'snapshot 2026-09-27']);
    assert.equal(await run(['--verify']), 1);
  });

  test('[postgres] verify fails when the schema is missing', async () => {
    seedRedis(fake);
    const m = await verify({ redis, pool, userIds: [USER], primaryUserId: USER });
    assert.deepEqual(m.map((x) => x.what), ['schema']);
  });

  test('[postgres] a real run with unmappable records writes nothing', async () => {
    seedRedis(fake);
    fake.store.set('stray-key', 'x');
    assert.equal(await run([]), 1);
    assert.equal(await postgresCounts(pool, USER, 'ai-pm'), null);
  });

  test('[postgres] --user migrates another user into its own library topic', async () => {
    seedRedis(fake);
    seedRedis(fake, { user: 'u2' });
    assert.equal(await run(['--user', 'u2']), 0);
    assert.equal((await postgresCounts(pool, 'u2', 'u2-library')).concepts, 3);
    assert.equal(await run(['--verify', '--user', 'u2']), 0);
    await migrate(pool, { log: quiet }); // already applied: no-op
  });

  test('[postgres] a session id owned by another user fails the run instead of overwriting', async () => {
    seedRedis(fake);
    seedRedis(fake, { user: 'u2' });
    fake.store.set('session:u2', JSON.stringify({ sessionId: `s-${USER}` }));
    await assert.rejects(run(['--user', 'u2']), /belongs to another user/);
    const { rows } = await pool.query('SELECT user_id FROM sessions');
    assert.deepEqual(rows, [{ user_id: USER }], 'owner row untouched; u2 rolled back');
  });
}
