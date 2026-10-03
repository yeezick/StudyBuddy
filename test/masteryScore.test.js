import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masteryScore, isDue, SETTLED_STABILITY_DAYS, SHORT_TERM_DUE_MS } from '../src/lib/mastery.js';
import { buildReviewEvent, isIdleLatency, IDLE_LATENCY_MS } from '../src/lib/reviewEvents.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

// A stored FSRS card (state 2 = Review) last reviewed `daysAgo` days before NOW.
const fsrsCard = (stability, daysAgo, extra = {}) => ({
  conceptId: 'c1', scheduler: 'fsrs', score: 0.45,
  due: ago(-DAY), stability, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0,
  reps: 3, lapses: 0, state: 2, last_review: ago(daysAgo * DAY),
  lastReviewedAt: ago(daysAgo * DAY), nextReviewAt: ago(-DAY), ...extra,
});

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

// FSRS defines stability as the interval at which recall falls to 90%, so R(t = S) = 0.9 and
// R(0) = 1. That gives exact hand values for R × min(1, S / 21).
test('T4b-2: mastery = R_now × min(1, S/21), hand-checked', () => {
  assert.equal(SETTLED_STABILITY_DAYS, 21);
  close(masteryScore(fsrsCard(21, 21), NOW, 'fsrs'), 0.9);        // settled, at its interval: 0.9 × 1
  close(masteryScore(fsrsCard(7, 7), NOW, 'fsrs'), 0.3);          // 0.9 × 7/21
  close(masteryScore(fsrsCard(10.5, 0), NOW, 'fsrs'), 0.5);       // just reviewed: 1 × 10.5/21
  close(masteryScore(fsrsCard(42, 0), NOW, 'fsrs'), 1);           // capped at 1
  // Whole days (ts-fsrs): 20 h after a review still reads R = 1.
  close(masteryScore(fsrsCard(10.5, 20 / 24), NOW, 'fsrs'), 0.5);
  // Overdue lowers R below 0.9.
  assert.ok(masteryScore(fsrsCard(21, 60), NOW, 'fsrs') < 0.9);
});

test('T4b-2: a new card scores 0; no card scores 0', () => {
  const fresh = { ...fsrsCard(0, 0), state: 0, stability: 0, reps: 0, last_review: null, lastReviewedAt: null };
  assert.equal(masteryScore(fresh, NOW, 'fsrs'), 0);
  assert.equal(masteryScore(null, NOW, 'fsrs'), 0);
  assert.equal(masteryScore({ conceptId: 'c1', score: 0, easeFactor: 2.5, interval: 1, repetitions: 0, nextReviewAt: null, lastReviewedAt: null }, NOW, 'fsrs'), 0);
});

test('T4b-2: an unconverted SM-2 card is scored through the T4-4 conversion (S = interval)', () => {
  const sm2 = { conceptId: 'c1', score: 0.3, easeFactor: 2.5, interval: 6, repetitions: 2, lastReviewedAt: ago(6 * DAY), nextReviewAt: NOW.toISOString() };
  close(masteryScore(sm2, NOW, 'fsrs'), 0.9 * 6 / 21);
});

test('T4b-2: SCHEDULER=sm2 keeps the old score min(1, reps × 0.15)', () => {
  assert.equal(masteryScore(fsrsCard(21, 21), NOW, 'sm2'), 0.45);
  assert.equal(masteryScore({ conceptId: 'c1', score: 0.3, repetitions: 2 }, NOW, 'sm2'), 0.3);
  assert.equal(masteryScore({ conceptId: 'c1' }, NOW, 'sm2'), 0);
});

test('T4b-3: due lists ignore short-term dues until 1 h after the review', () => {
  assert.equal(SHORT_TERM_DUE_MS, 60 * 60 * 1000);
  const relearning = (reviewedMsAgo, dueInMsAfterReview) => ({
    lastReviewedAt: ago(reviewedMsAgo),
    nextReviewAt: ago(reviewedMsAgo - dueInMsAfterReview),
  });
  // Wrong answer 20 min ago, 10-minute step: FSRS says due, the lists do not.
  assert.equal(isDue(relearning(20 * 60e3, 10 * 60e3), NOW), false);
  // Same card 61 min after the review: now it counts.
  assert.equal(isDue(relearning(61 * 60e3, 10 * 60e3), NOW), true);
  // Exactly 1 h after the review counts.
  assert.equal(isDue(relearning(60 * 60e3, 60e3), NOW), true);
  // Regular intervals are unchanged.
  assert.equal(isDue({ lastReviewedAt: ago(3 * DAY), nextReviewAt: ago(DAY) }, NOW), true);
  assert.equal(isDue({ lastReviewedAt: ago(DAY), nextReviewAt: ago(-DAY) }, NOW), false);
  // Due in the next hour is not due; never-scheduled is not due.
  assert.equal(isDue({ lastReviewedAt: ago(DAY), nextReviewAt: ago(-30 * 60e3) }, NOW), false);
  assert.equal(isDue({ nextReviewAt: null }, NOW), false);
  // A due without a last review (legacy) is taken as is.
  assert.equal(isDue({ nextReviewAt: ago(60e3) }, NOW), true);
});

test('T4b-4: idle flag is latency > 5 min, raw latency kept', () => {
  assert.equal(IDLE_LATENCY_MS, 300000);
  assert.equal(isIdleLatency(300000), false);
  assert.equal(isIdleLatency(300001), true);
  assert.equal(isIdleLatency(null), null);

  const quiz = { userId: 'u1', quizId: 'q', trigger: 'on_demand' };
  const q = (latency) => ({
    conceptId: 'c1', type: 'mcq', isCorrect: true, confidenceRating: 2,
    shownAt: ago(latency), answeredAt: NOW.toISOString(),
  });
  const transition = { prev: { conceptId: 'c1', reps: 0 }, next: { conceptId: 'c1', reps: 1 }, retrievability: null };

  const slow = buildReviewEvent(quiz, q(847000), transition);
  assert.equal(slow.latencyMs, 847000);
  assert.equal(slow.nextState.idle_latency, true);

  const quick = buildReviewEvent(quiz, q(30000), transition);
  assert.equal(quick.latencyMs, 30000);
  assert.equal(quick.nextState.idle_latency, false);
});
