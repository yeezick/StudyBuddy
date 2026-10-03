import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubRedis } from './helpers/fakeRedis.js';
import { storeContract } from './helpers/storeContract.js';
import { redis } from '../src/redis.js';
import { createRedisStore } from '../src/store/redisStore.js';
import { createStoreFromEnv } from '../src/store/index.js';

let fake;

storeContract('redis', async () => {
  fake = stubRedis();
  return { store: createRedisStore({ redis }), cleanup: () => fake.restore() };
});

test('[redis] keeps the production key layout', async () => {
  const f = stubRedis();
  try {
    const store = createRedisStore({ redis });
    await store.seedConcepts('u1', [{ id: 'c1', name: 'n', summary: 's' }]);
    await store.saveCard('u1', { conceptId: 'c1', score: 0 });
    await store.saveQuiz({ quizId: 'q1' });
    await store.setActiveQuizId('u1', 'q1');
    await store.saveSession('u1', { sessionId: 's1' });
    await store.saveMasterySnapshot('u1', '2026-10-01', { modules: [] });
    await store.addHistory('u1', { quizId: 'q1' });
    assert.deepEqual([...f.store.keys()].sort(), [
      'active-quiz:u1', 'concepts:u1', 'mastery-snapshot:u1:2026-10-01', 'mastery:u1:c1', 'quiz:q1', 'session:u1',
    ]);
    assert.deepEqual([...f.lists.keys()], ['history:u1']);
  } finally {
    f.restore();
  }
});

test('[redis] history keeps the last 30 entries', async () => {
  const f = stubRedis();
  try {
    const store = createRedisStore({ redis });
    for (let i = 0; i < 35; i++) await store.addHistory('u1', { quizId: `q${i}` });
    assert.equal(f.lists.get('history:u1').length, 30);
    assert.equal((await store.getHistory('u1', 1))[0].quizId, 'q34');
  } finally {
    f.restore();
  }
});

test('T1-5: STORE_BACKEND selects the backend; redis is the default', () => {
  assert.equal(createStoreFromEnv({}).backend, 'redis');
  assert.equal(createStoreFromEnv({ STORE_BACKEND: 'redis' }).backend, 'redis');
  assert.throws(() => createStoreFromEnv({ STORE_BACKEND: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => createStoreFromEnv({ STORE_BACKEND: 'mongo' }), /Unknown STORE_BACKEND "mongo"/);
  // The pool connects lazily and close() never connects, so any non-empty value will do here.
  const pgStore = createStoreFromEnv({ STORE_BACKEND: 'postgres', DATABASE_URL: 'placeholder-never-connected' });
  assert.equal(pgStore.backend, 'postgres');
  return pgStore.close();
});
