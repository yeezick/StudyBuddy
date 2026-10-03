import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubRedis } from './helpers/fakeRedis.js';
import { buildMasterySnapshot, formatMasteryBlocks } from '../src/slack/masteryFlow.js';

let fake;
beforeEach(() => { fake = stubRedis(); });
afterEach(() => fake.restore());

const CONCEPTS = [
  { id: 'a', name: 'Alpha', scope: { course: 'Test Course', module: 'Module 1', moduleLabel: 'Getting Started' } },
  { id: 'b', name: 'Beta', scope: { course: 'Test Course', module: 'Module 1' } },
  { id: 'c', name: 'Gamma', scope: { course: 'Test Course', module: 'Module 2' } },
];

test('labels come from the seed and fall back to the module name', async () => {
  fake.store.set('concepts:u1', JSON.stringify(CONCEPTS));
  fake.store.set('mastery:u1:a', JSON.stringify({ conceptId: 'a', score: 0.6, nextReviewAt: '2000-01-01T00:00:00Z' }));

  const snapshot = await buildMasterySnapshot('u1');
  assert.deepEqual(snapshot.modules.map((m) => m.label), ['Getting Started', 'Module 2']);
  assert.equal(snapshot.modules[0].avg, 0.3);
  assert.deepEqual(snapshot.dueToday, ['Alpha']);

  const text = JSON.stringify(formatMasteryBlocks(snapshot));
  assert.match(text, /Test Course/);
  assert.ok(text.includes('Getting Started  ███░░░░░░░   30%  (2 concepts)'), text);
  assert.ok(text.includes('Module 2         ░░░░░░░░░░    0%  (1 concepts)'), 'fallback label padded to the widest label');
});

test('empty library → null snapshot', async () => {
  assert.equal(await buildMasterySnapshot('nobody'), null);
});
