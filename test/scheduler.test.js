import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redisRetryDelay } from '../src/scheduler/jobs.js';

test('S0-5: Redis retry is bounded with capped backoff', () => {
  assert.equal(redisRetryDelay(1), 1000);
  assert.equal(redisRetryDelay(5), 5000);
  assert.equal(redisRetryDelay(20), 20000);
  assert.equal(redisRetryDelay(21), null);
  assert.equal(redisRetryDelay(40, 50), 30000);
  let total = 0;
  for (let t = 1; redisRetryDelay(t) !== null; t++) total += redisRetryDelay(t);
  assert.ok(total < 5 * 60 * 1000, `gives up within 5 min (total ${total / 1000}s)`);
});
