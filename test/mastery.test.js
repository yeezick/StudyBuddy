import './helpers/env.js';
import { test, beforeEach, afterEach, after } from 'node:test';
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

// Under the SM-2 rollback /mastery shows min(1, reps × 0.15) (DEC-056 §1).
test('labels come from the seed and fall back to the module name (SCHEDULER=sm2)', async () => {
  process.env.SCHEDULER = 'sm2';
  after(() => { delete process.env.SCHEDULER; });
  fake.store.set('concepts:u1', JSON.stringify(CONCEPTS));
  fake.store.set('mastery:u1:a', JSON.stringify({ conceptId: 'a', repetitions: 4, nextReviewAt: '2000-01-01T00:00:00Z' }));

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

test('T4b-2/3: under FSRS the snapshot scores R × min(1, S/21) and skips short-term dues', async () => {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const card = (id, stability, reviewedAgo, dueIn) => ({
    conceptId: id, scheduler: 'fsrs', stability, difficulty: 5, elapsed_days: 0,
    scheduled_days: 0, learning_steps: 0, reps: 6, lapses: 0, state: 2,
    last_review: at(-reviewedAgo), lastReviewedAt: at(-reviewedAgo), due: at(dueIn), nextReviewAt: at(dueIn),
  });
  fake.store.set('concepts:u1', JSON.stringify(CONCEPTS));
  // Alpha: reviewed 2 h ago (R = 1, whole days), S = 10.5 → 0.5. Due 1 h ago → counts (≥ 1 h after review).
  fake.store.set('mastery:u1:a', JSON.stringify(card('a', 10.5, 2 * 3600e3, -3600e3)));
  // Beta: wrong 20 min ago, 10-minute relearning step already passed → not listed. S = 0.3.
  fake.store.set('mastery:u1:b', JSON.stringify(card('b', 0.3, 20 * 60e3, -10 * 60e3)));
  // Gamma: never reviewed → 0, not due.

  const snapshot = await buildMasterySnapshot('u1');
  assert.ok(Math.abs(snapshot.modules[0].avg - (0.5 + 0.3 / 21) / 2) < 1e-6, String(snapshot.modules[0].avg));
  assert.equal(snapshot.modules[1].avg, 0);
  assert.deepEqual(snapshot.dueToday, ['Alpha']);
});
