import { TEST_ENV } from './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection, redisRetryDelay } from '../src/scheduler/jobs.js';

const JOBS = new URL('../src/scheduler/jobs.js', import.meta.url).href;
const fastRetry = (times, max) => (times > max ? null : 10);

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

test('S0b-2: giving up on Redis calls the give-up hook exactly once', async () => {
  let calls = 0;
  let resolveGaveUp;
  const gaveUp = new Promise((r) => { resolveGaveUp = r; });
  const conn = createConnection({
    url: TEST_ENV.REDIS_URL,
    maxRetries: 2,
    retryDelay: fastRetry,
    onGiveUp: () => { calls++; resolveGaveUp(); },
  });
  const dup = conn.duplicate(); // BullMQ duplicates the connection; the hook must still fire once
  conn.on('error', () => {});
  dup.on('error', () => {});
  await gaveUp;
  await new Promise((r) => setTimeout(r, 100));
  conn.disconnect();
  dup.disconnect();
  assert.equal(calls, 1);
});

test('S0b-2: by default the process exits 1 when Redis is unreachable', async () => {
  const script = `
    const { createConnection } = await import(${JSON.stringify(JOBS)});
    createConnection({ maxRetries: 1, retryDelay: (t, m) => (t > m ? null : 10) }).on('error', () => {});
    setTimeout(() => process.exit(0), 5000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, ...TEST_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1, output);
  assert.equal(output.match(/giving up after 1 retries/g)?.length, 1, output);
});
