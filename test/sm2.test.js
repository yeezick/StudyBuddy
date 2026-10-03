import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultMastery, updateMastery, qualityScoreFromMCQ, qualityScoreFromFreeText } from '../src/lib/sm2.js';

const days = (iso) => (new Date(iso).getTime() - Date.now()) / 86400000;

test('defaults', () => {
  const m = defaultMastery('c1');
  assert.equal(m.easeFactor, 2.5);
  assert.equal(m.interval, 1);
  assert.equal(m.repetitions, 0);
});

test('wrong answer resets repetitions and lowers EF', () => {
  const m = updateMastery(defaultMastery('c1'), 1);
  assert.equal(m.repetitions, 0);
  assert.equal(m.interval, 1);
  assert.ok(Math.abs(m.easeFactor - 1.96) < 0.001);
  assert.ok(Math.abs(days(m.nextReviewAt) - 1) < 0.05);
});

test('interval sequence 1 → 6 → round(6 × EF), score steps by 0.15', () => {
  const r1 = updateMastery(defaultMastery('c1'), 5);
  const r2 = updateMastery(r1, 4);
  const r3 = updateMastery(r2, 4);
  assert.deepEqual([r1.interval, r2.interval, r3.interval], [1, 6, Math.round(6 * r2.easeFactor)]);
  assert.ok(Math.abs(r3.score - 0.45) < 1e-9);
});

test('EF never drops below 1.3 and score caps at 1', () => {
  let m = defaultMastery('c1');
  for (let i = 0; i < 20; i++) m = updateMastery(m, 3);
  assert.ok(m.easeFactor >= 1.3);
  assert.ok(m.score <= 1);
});

test('quality score mapping', () => {
  assert.equal(qualityScoreFromMCQ(false, 3), 1);
  assert.deepEqual([1, 2, 3].map((c) => qualityScoreFromMCQ(true, c)), [3, 4, 5]);
  assert.equal(qualityScoreFromFreeText(1, 3), 5);
  assert.equal(qualityScoreFromFreeText(0.8, 1), 3);
  assert.equal(qualityScoreFromFreeText(0, 1), 0);
});
