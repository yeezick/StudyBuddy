import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stubRedis } from './helpers/fakeRedis.js';
import { store } from '../src/store/index.js';
import { createMcpServer } from '../src/mcp/server.js';

const USER = 'test-user';
let fake;
let client;

beforeEach(async () => {
  fake = stubRedis();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
});
afterEach(async () => {
  await client.close();
  fake.restore();
});

const call = (args) => client.callTool({ name: 'get_reviews', arguments: args });
const events = (res) => JSON.parse(res.content[0].text);

test('T3-4: get_reviews returns events newest first with topic, since and limit filters', async () => {
  const at = (h) => `2026-10-03T${String(h).padStart(2, '0')}:00:00.000Z`;
  await store.appendReviewEvent({ userId: USER, conceptId: 'c1', itemType: 'mcq', correct: true, grade: 3, ts: at(8) });
  await store.appendReviewEvent({ userId: USER, conceptId: 'c2', itemType: 'mcq', correct: false, grade: 1, ts: at(9), topicId: 'other' });
  await store.appendReviewEvent({ userId: USER, conceptId: 'c3', itemType: 'free_text', correct: true, grade: 4, ts: at(10) });

  assert.deepEqual(events(await call({ userId: USER })).map((e) => e.conceptId), ['c3', 'c2', 'c1']);
  assert.deepEqual(events(await call({ userId: USER, topicId: 'ai-pm' })).map((e) => e.conceptId), ['c3', 'c1']);
  assert.deepEqual(events(await call({ userId: USER, since: at(9) })).map((e) => e.conceptId), ['c3', 'c2']);
  assert.deepEqual(events(await call({ userId: USER, limit: 1 })).map((e) => e.conceptId), ['c3']);
  assert.equal(events(await call({ userId: USER, limit: 1 }))[0].grade, 4);
});

test('T3-4: get_reviews rejects unknown users and bad arguments, and is listed', async () => {
  const unknown = await call({ userId: 'someone-else' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unauthorized userId/);

  const badSince = await call({ userId: USER, since: 'yesterday' });
  assert.equal(badSince.isError, true);
  const badLimit = await call({ userId: USER, limit: 501 });
  assert.equal(badLimit.isError, true);

  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'get_reviews'));
});
