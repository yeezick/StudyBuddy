import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { State } from 'ts-fsrs';
import { gradeFor } from '../src/lib/grade.js';
import { scheduler, memoryStateFromSm2, fsrsFieldsFromSm2 } from '../src/lib/fsrs.js';
import { reviewCard, normalizeCard, schedulerName, masteryScore } from '../src/lib/mastery.js';
import { defaultMastery } from '../src/lib/sm2.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// A flat SM-2 card as production holds it before T4.
const legacy = {
  conceptId: 'c1', score: 0.3, easeFactor: 2.5, interval: 6, repetitions: 2,
  nextReviewAt: '2026-10-08T09:00:00.000Z', lastReviewedAt: '2026-10-02T09:00:00.000Z',
};

test('T4-1: FSRS-6 defaults, 90% retention, fuzz and short-term on', () => {
  const p = scheduler.parameters;
  assert.equal(p.request_retention, 0.9);
  assert.equal(p.w.length, 21);
  assert.equal(p.enable_fuzz, true);
  assert.equal(p.enable_short_term, true);
});

test('T4-2: grade matrix — MCQ and free text × right/wrong × confidence 1/2/3/missing', () => {
  const expected = { false: [1, 1, 1, 1], true: [2, 3, 4, 3] }; // confidence 1, 2, 3, missing
  for (const type of ['mcq', 'short_answer']) {
    for (const isCorrect of [false, true]) {
      [1, 2, 3, undefined].forEach((confidenceRating, i) => {
        assert.equal(gradeFor({ type, isCorrect, confidenceRating, pointsEarned: isCorrect ? 1 : 0 }),
          expected[isCorrect][i], `${type} correct=${isCorrect} confidence=${confidenceRating}`);
      });
    }
  }
});

test('T4-2: free-text score never moves the grade when it disagrees with the verdict', () => {
  // AI says correct but scored low; AI says wrong but scored high.
  assert.equal(gradeFor({ type: 'short_answer', isCorrect: true, pointsEarned: 0.2, confidenceRating: 3 }), 4);
  assert.equal(gradeFor({ type: 'short_answer', isCorrect: true, pointsEarned: 0, confidenceRating: 2 }), 3);
  assert.equal(gradeFor({ type: 'short_answer', isCorrect: false, pointsEarned: 0.9, confidenceRating: 3 }), 1);
  assert.equal(gradeFor({ type: 'short_answer', isCorrect: false, pointsEarned: 1, confidenceRating: null }), 1);
});

test('T4-4: SM-2 → FSRS memory state matches hand-checked values', () => {
  // D = 11 − (EF − 1) / (e^w8 · S^−w9 · (e^(0.1·w10) − 1)), w8 = 1.8722, w9 = 0.1666, w10 = 0.796.
  // EF 2.5, I 6: e^1.8722 = 6.5020, 6^−0.1666 = 0.7420, e^0.0796 − 1 = 0.08285 → 1.5 / 0.3997 = 3.753 → D = 7.247.
  const cases = [
    [2.5, 6, 6, 7.247398],
    [2.5, 1, 1, 8.215851],
    [2.36, 15, 15, 7.036518],
    [2.7, 40, 40, 5.166176],
    [1.3, 100, 100, 9.800715],
    [1.3, 1, 1, 10], // 10.443 before the clamp
  ];
  for (const [ef, interval, s, d] of cases) {
    const m = memoryStateFromSm2(ef, interval);
    near(m.stability, s, 1e-9);
    near(m.difficulty, d, 1e-5);
  }
});

test('T4-4: conversion keeps the due date and reps; a never-reviewed card becomes new', () => {
  const f = fsrsFieldsFromSm2(legacy, NOW);
  assert.equal(f.due, legacy.nextReviewAt);
  assert.equal(f.last_review, legacy.lastReviewedAt);
  assert.equal(f.reps, 2);
  assert.equal(f.state, State.Review);
  near(f.stability, 6);

  const fresh = fsrsFieldsFromSm2(defaultMastery('c2'), NOW);
  assert.equal(fresh.state, State.New);
  assert.equal(fresh.stability, 0);
  assert.equal(fresh.due, NOW.toISOString());
});

test('T4-4: normalizeCard converts lazily, keeps SM-2 under sm2 and leaves display fields alone', () => {
  const c = normalizeCard(legacy, NOW);
  assert.deepEqual(c.sm2, {
    easeFactor: 2.5, interval: 6, repetitions: 2,
    nextReviewAt: legacy.nextReviewAt, lastReviewedAt: legacy.lastReviewedAt,
  });
  assert.equal(c.nextReviewAt, legacy.nextReviewAt, 'no reschedule');
  assert.equal('score' in c, false, 'the stored pre-FSRS score is dropped');
  assert.equal(c.convertedFromSm2At, NOW.toISOString());
  assert.equal(c.easeFactor, undefined, 'flat SM-2 fields moved under sm2');
  assert.equal(normalizeCard(c, NOW), c, 'already-converted card is returned as is');
});

test('T4-3: an FSRS review sets due = nextReviewAt and logs retrievability', () => {
  const { prev, next, retrievability } = reviewCard(legacy, 3, NOW, 'fsrs');
  near(prev.stability, 6);
  assert.equal(next.scheduler, 'fsrs');
  assert.equal(next.nextReviewAt, next.due);
  assert.equal(next.last_review, NOW.toISOString());
  assert.equal(next.reps, 3);
  assert.ok(next.stability > 6, 'Good on a review card grows stability');
  assert.ok(new Date(next.due) > NOW);
  // Whole days elapsed = 2, S = 6: factor = 0.9^(−1/0.1542) − 1 = 0.9805,
  // R = (1 + 0.9805·2/6)^−0.1542 = 0.9573.
  near(retrievability, 0.9573, 0.0005);
  // SM-2 shadow: quality 4 on rep 2 → interval round(6 × 2.5) = 15; rollback score = 3 × 0.15.
  assert.equal(next.sm2.interval, 15);
  assert.equal(next.sm2.repetitions, 3);
  assert.equal('score' in next, false, 'no score is stored');
  near(masteryScore(next, NOW, 'sm2'), 0.45);
});

test('T4-3: Again counts a lapse and resets the rollback score; a new card has no retrievability', () => {
  const again = reviewCard(legacy, 1, NOW, 'fsrs').next;
  assert.equal(again.lapses, 1);
  assert.equal(again.state, State.Relearning);
  assert.equal(masteryScore(again, NOW, 'sm2'), 0);

  const first = reviewCard(defaultMastery('c2'), 3, NOW, 'fsrs');
  assert.equal(first.prev.state, State.New);
  assert.equal(first.retrievability, null);
  assert.equal(first.next.state, State.Learning);
  near(masteryScore(first.next, NOW, 'sm2'), 0.15);
});

test('T4-7: SCHEDULER=sm2 schedules from state.sm2 and leaves FSRS fields untouched', () => {
  const converted = reviewCard(legacy, 3, NOW, 'fsrs').next;
  const later = new Date('2026-10-20T12:00:00.000Z');
  const { next, retrievability } = reviewCard(converted, 3, later, 'sm2');
  assert.equal(next.scheduler, 'sm2');
  assert.equal(retrievability, null);
  assert.equal(next.sm2.interval, Math.round(15 * converted.sm2.easeFactor));
  assert.equal(next.nextReviewAt, next.sm2.nextReviewAt);
  assert.equal(next.stability, converted.stability);
  assert.equal(next.due, converted.due);

  // An unconverted card stays SM-2 only, with its state moved under sm2.
  const flat = reviewCard(legacy, 3, NOW, 'sm2').next;
  assert.equal('score' in flat, false, 'rollback does not store a score either');
  assert.equal(flat.stability, undefined);
  assert.equal(flat.easeFactor, undefined);
  assert.equal(flat.sm2.interval, 15);
  // ...and is converted from that state when FSRS comes back.
  near(normalizeCard(flat, later).stability, 15);
});

test('T4-7: SCHEDULER defaults to fsrs; unknown values fall back to fsrs', () => {
  assert.equal(schedulerName({}), 'fsrs');
  assert.equal(schedulerName({ SCHEDULER: 'sm2' }), 'sm2');
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal(schedulerName({ SCHEDULER: 'anki' }), 'fsrs');
  } finally {
    console.error = realError;
  }
});
