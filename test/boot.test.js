import { TEST_ENV } from './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { testDbEnabled, assertLocalTestDb, pgEnv } from './helpers/testDb.js';

const ENTRY = new URL('../src/index.js', import.meta.url).pathname;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function boot(extraEnv = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, ...TEST_ENV, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return { child, output: () => output };
}

async function pollHealth(port, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return { res, elapsed: Date.now() - start };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`/health did not answer within ${deadlineMs}ms`);
}

test('S0-4: /health answers within 2 s with Redis and Slack unreachable; /mcp needs the token', async () => {
  const port = await freePort();
  const { child, output } = boot({ PORT: String(port) });
  try {
    const { res, elapsed } = await pollHealth(port, 2000);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.deps.redis.state, 'error');
    assert.ok(elapsed < 2000, `answered in ${elapsed}ms`);

    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/mcp/sse`)).status, 401);
    assert.equal((await fetch(`${base}/mcp/messages?sessionId=x`, { method: 'POST' })).status, 401);
    const ac = new AbortController();
    const sse = await fetch(`${base}/mcp/sse`, { headers: { Authorization: `Bearer ${TEST_ENV.MCP_AUTH_TOKEN}` }, signal: ac.signal });
    assert.equal(sse.status, 200);
    ac.abort();

    assert.equal((await fetch(`${base}/test/ping`)).status, 404, 'S0-2: /test/ping removed');
  } catch (err) {
    err.message += `\n--- server output ---\n${output()}`;
    throw err;
  } finally {
    child.kill();
  }
});

test('S0-1: production boot without MCP_AUTH_TOKEN exits non-zero', async () => {
  const port = await freePort();
  const { child, output } = boot({ PORT: String(port), NODE_ENV: 'production', MCP_AUTH_TOKEN: '' });
  const killer = setTimeout(() => child.kill(), 5000); // a boot that wrongly succeeds must not linger
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(killer);
  assert.notEqual(code, 0);
  assert.match(output(), /MCP_AUTH_TOKEN/);
});

test('T1-5: boot with STORE_BACKEND=postgres migrates, seeds through the store and reports it', { skip: !testDbEnabled() && 'TEST_POSTGRES unset' }, async () => {
  assertLocalTestDb();
  const { default: pg } = await import('pg');
  const schema = `t1_boot_${process.pid}`;
  const admin = new pg.Pool({ max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const port = await freePort();
  // The child gets a minimal env: hand it the PG* connection variables plus its own schema.
  const { child, output } = boot({ ...pgEnv(), PGOPTIONS: `-c search_path=${schema}`, PORT: String(port), STORE_BACKEND: 'postgres' });
  try {
    await pollHealth(port, 2000);
    let body;
    for (let i = 0; i < 50; i++) {
      body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      if (body.deps.seed?.state === 'ok' || body.deps.seed?.state === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(body.storeBackend, 'postgres');
    assert.equal(body.deps.store.state, 'ok', JSON.stringify(body.deps.store));
    assert.equal(body.deps.seed.state, 'ok', JSON.stringify(body.deps.seed));
    const { rows } = await admin.query(`SELECT COUNT(*)::int AS n FROM ${schema}.concepts`);
    assert.ok(rows[0].n > 0, 'example seed written to Postgres');
  } catch (err) {
    err.message += `\n--- server output ---\n${output()}`;
    throw err;
  } finally {
    child.kill();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
