import { TEST_ENV } from './helpers/env.js';
import { stubRedis } from './helpers/fakeRedis.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { requireBearer } from '../src/lib/auth.js';
import { mountMcp } from '../src/mcp/server.js';
import { diffConcepts } from '../src/mcp/conceptOps.js';
import { connectMcp, loadConcepts } from '../scripts/load-concepts.js';

const EXAMPLE = JSON.parse(fs.readFileSync(new URL('../content/concepts-seed.example.json', import.meta.url), 'utf8'));
const USER = TEST_ENV.SINGLE_USER_ID;
const KEY = `concepts:${USER}`;

// Shares two ids with the example (one edited, one identical), drops the third, adds two.
const SEED = [
  { ...EXAMPLE[0], summary: 'Edited summary.', mastery: { score: 0 } },
  { ...EXAMPLE[1], mastery: { score: 0 } },
  { id: 'm9-c01', name: 'New A', summary: 'A.', scope: { module: 'Module 9', moduleLabel: 'Nine' }, tags: [] },
  { id: 'm9-c02', name: 'New B', summary: 'B.', scope: { module: 'Module 9', moduleLabel: 'Nine' } },
];

let redis;
let server;
let url; // localhost, not 127.0.0.1: the fake Redis intercepts fetches to http://127.0.0.1:1…

before(async () => {
  redis = stubRedis();
  const app = express();
  mountMcp(app, requireBearer());
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  url = `http://localhost:${server.address().port}/mcp/sse`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  redis.restore();
});

const stored = () => JSON.parse(redis.store.get(KEY));
const quiet = () => {};

test('S0b-4: diffConcepts ignores key order and seed-only fields', () => {
  const reordered = { scope: { ...EXAMPLE[0].scope }, tags: EXAMPLE[0].tags, summary: EXAMPLE[0].summary, name: EXAMPLE[0].name, id: EXAMPLE[0].id, mastery: {} };
  const plan = diffConcepts([EXAMPLE[0]], [reordered]);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.change.length, 0);
  assert.throws(() => diffConcepts([], [EXAMPLE[0], EXAMPLE[0]]), /duplicate concept ids: m1-c01/);
});

test('S0b-4: wrong bearer token cannot connect', async () => {
  await assert.rejects(connectMcp(url, 'wrong-token'), /401/);
});

test('S0b-4: dry run over authenticated MCP writes nothing', async () => {
  redis.store.set(KEY, JSON.stringify(EXAMPLE));
  const client = await connectMcp(url, TEST_ENV.MCP_AUTH_TOKEN);
  try {
    const plan = await loadConcepts({ client, userId: USER, seed: SEED, dryRun: true, log: quiet });
    assert.deepEqual(plan.add.map((c) => c.id), ['m9-c01', 'm9-c02']);
    assert.deepEqual(plan.change.map((c) => c.id), [EXAMPLE[0].id]);
    assert.deepEqual(plan.remove.map((c) => c.id), [EXAMPLE[2].id]);
    assert.deepEqual(plan.unchanged.map((c) => c.id), [EXAMPLE[1].id]);
  } finally {
    await client.close();
  }
  assert.deepEqual(stored(), EXAMPLE);
});

test('S0b-4: real run replaces the library with the seed, and re-running is a no-op', async () => {
  redis.store.set(KEY, JSON.stringify(EXAMPLE));
  const client = await connectMcp(url, TEST_ENV.MCP_AUTH_TOKEN);
  try {
    await loadConcepts({ client, userId: USER, seed: SEED, log: quiet });
    const ids = stored().map((c) => c.id).sort();
    assert.deepEqual(ids, SEED.map((c) => c.id).sort());
    const edited = stored().find((c) => c.id === EXAMPLE[0].id);
    assert.equal(edited.summary, 'Edited summary.');
    assert.equal(edited.scope.moduleLabel, EXAMPLE[0].scope.moduleLabel);
    assert.ok(stored().every((c) => !('mastery' in c)));

    const again = await loadConcepts({ client, userId: USER, seed: SEED, log: quiet });
    assert.equal(again.add.length + again.change.length + again.remove.length, 0);
  } finally {
    await client.close();
  }
});

test('S0b-4: two MCP clients can be connected at once', async () => {
  redis.store.set(KEY, JSON.stringify(EXAMPLE));
  const [a, b] = await Promise.all([connectMcp(url, TEST_ENV.MCP_AUTH_TOKEN), connectMcp(url, TEST_ENV.MCP_AUTH_TOKEN)]);
  try {
    const results = await Promise.all([a, b].map((c) => c.callTool({ name: 'get_concepts', arguments: { userId: USER } })));
    for (const r of results) assert.equal(JSON.parse(r.content[0].text).length, EXAMPLE.length);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
