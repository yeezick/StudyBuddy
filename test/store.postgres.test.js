import './helpers/env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { stubRedis } from './helpers/fakeRedis.js';
import { storeContract } from './helpers/storeContract.js';
import { redis } from '../src/redis.js';
import { createRedisStore } from '../src/store/redisStore.js';
import { createPostgresStore, libraryTopicId, DEFAULT_TOPIC_ID } from '../src/store/postgresStore.js';
import { migrate } from '../src/store/migrate.js';
import { testDbEnabled, assertLocalTestDb } from './helpers/testDb.js';

// A throwaway local Postgres (CI uses a service container), set by the PG* variables; see
// helpers/testDb.js. Every run works in its own schema and drops it afterwards.
const TABLES = ['users', 'topics', 'concepts', 'cards', 'review_events', 'sessions', 'quiz_history', 'mastery_snapshots'];

if (!testDbEnabled()) {
  // CI must run these; locally they are skipped without a database.
  test('[postgres] store contract', { skip: process.env.CI ? false : 'TEST_POSTGRES unset' }, () => {
    assert.fail('TEST_POSTGRES is unset in CI — the Postgres contract did not run');
  });
} else {
  assertLocalTestDb();
  const schema = `t1_test_${process.pid}`;
  let admin;
  let pool;

  before(async () => {
    admin = new pg.Pool({ max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ max: 4, options: `-c search_path=${schema}` });
    await migrate(pool, { log: () => {} });
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  let fake;
  storeContract('postgres', async () => {
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    fake = stubRedis();
    const store = createPostgresStore({ pool, ephemeral: createRedisStore({ redis }), migrateOnInit: false });
    return { store, cleanup: () => fake.restore() };
  });

  test('[postgres] migrations are recorded and re-running applies nothing', async () => {
    assert.deepEqual(await migrate(pool, { log: () => {} }), []);
    const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows.map((r) => r.version), ['001_init']);
  });

  test('[postgres] concepts use {topicId}:{localId} ids and record provenance; cards carry due', async () => {
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const store = createPostgresStore({ pool, ephemeral: createRedisStore({ redis }), migrateOnInit: false });
    await store.seedConcepts('u1', [{ id: 'm1-c01', name: 'n', summary: 's', scope: { module: 'Module 1', lesson: 'L1' }, tags: ['a'] }]);
    await store.addConcepts('u1', [{ id: 'm1-c02', name: 'n2', summary: 's2' }]);
    const { rows } = await pool.query('SELECT id, topic_id, local_id, unit, lesson, tags, provenance, position FROM concepts ORDER BY position');
    const topic = libraryTopicId('u1');
    assert.deepEqual(rows.map((r) => [r.id, r.topic_id, r.local_id, r.unit, r.lesson, r.tags, r.provenance.addedBy, r.position]), [
      [`${topic}:m1-c01`, topic, 'm1-c01', 'Module 1', 'L1', ['a'], 'seed', 0],
      [`${topic}:m1-c02`, topic, 'm1-c02', null, null, [], 'mcp', 1],
    ]);

    await store.saveCard('u1', { conceptId: 'm1-c01', nextReviewAt: '2026-10-05T12:00:00.000Z' });
    const card = await pool.query('SELECT concept_id, due FROM cards');
    assert.equal(card.rows[0].concept_id, `${topic}:m1-c01`);
    assert.equal(card.rows[0].due.toISOString(), '2026-10-05T12:00:00.000Z');
  });

  test('[postgres] the primary user\'s library is topic ai-pm; other users get their own', async () => {
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const store = createPostgresStore({ pool, ephemeral: createRedisStore({ redis }), migrateOnInit: false, primaryUserId: 'owner' });
    await store.seedConcepts('owner', [{ id: 'm1-c01', name: 'n', summary: 's' }]);
    await store.seedConcepts('u2', [{ id: 'm1-c01', name: 'other', summary: 's' }]);
    const { rows } = await pool.query('SELECT id, owner_user_id FROM topics ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.id, r.owner_user_id]), [[DEFAULT_TOPIC_ID, 'owner'], ['u2-library', 'u2']]);
    assert.equal(DEFAULT_TOPIC_ID, 'ai-pm');
    assert.equal((await store.getConcepts('u2'))[0].name, 'other');
    const concepts = await pool.query('SELECT id FROM concepts ORDER BY id');
    assert.deepEqual(concepts.rows.map((r) => r.id), ['ai-pm:m1-c01', 'u2-library:m1-c01']);
  });

  test('[postgres] review_events is append-only', async () => {
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const store = createPostgresStore({ pool, ephemeral: createRedisStore({ redis }), migrateOnInit: false });
    await store.appendReviewEvent({ userId: 'u1', conceptId: 'c1', correct: true });
    await assert.rejects(pool.query('UPDATE review_events SET correct = false'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM review_events'), /append-only/);
    assert.equal((await store.getReviewEvents('u1')).length, 1);
  });

  test('[postgres] a failed seed rolls back as a whole and can be retried', async () => {
    await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const store = createPostgresStore({ pool, ephemeral: createRedisStore({ redis }), migrateOnInit: false });
    const good = { id: 'c1', name: 'n', summary: 's' };
    await assert.rejects(store.seedConcepts('u1', [good, { id: null, name: 'bad', summary: 's' }]), /local_id/);
    assert.deepEqual(await store.getConcepts('u1'), [], 'nothing from the failed seed is kept');
    assert.equal(await store.seedConcepts('u1', [good]), true);
    await store.saveCard('u1', { conceptId: 'c1', nextReviewAt: null }); // user row exists after the retry
    assert.deepEqual(await store.getConcepts('u1'), [good]);
  });
}
