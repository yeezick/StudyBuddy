import { store } from '../store/index.js';
import { qualityScoreFromMCQ, qualityScoreFromFreeText } from './sm2.js';

// Every graded quiz answer becomes one append-only review event (design §10 slice 4).
// Scheduling is untouched: the grade is derived from the same SM-2 quality the card update
// uses, so FSRS (a later slice) can replay the log.

// SM-2 quality (0–5) → the 1–4 grade column (Again / Hard / Good / Easy).
export function gradeFromQuality(quality) {
  if (quality < 3) return 1;
  if (quality === 3) return 2;
  if (quality === 4) return 3;
  return 4;
}

// The quality SM-2 gets for this question; a missing confidence counts as Medium, as before.
export function qualityOf(q) {
  return q.type === 'mcq'
    ? qualityScoreFromMCQ(q.isCorrect, q.confidenceRating ?? 2)
    : qualityScoreFromFreeText(q.pointsEarned ?? 0, q.confidenceRating ?? 2);
}

export function latencyMs(q) {
  if (!q.shownAt || !q.answeredAt) return null;
  const ms = Date.parse(q.answeredAt) - Date.parse(q.shownAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

export function buildReviewEvent(quiz, q) {
  return {
    userId: quiz.userId,
    conceptId: q.conceptId,
    ts: q.answeredAt ?? new Date().toISOString(),
    trigger: quiz.trigger,
    quizId: quiz.quizId,
    itemType: q.type === 'mcq' ? 'mcq' : 'free_text',
    correct: q.isCorrect,
    score: q.pointsEarned ?? null,
    confidence: q.confidenceRating ?? null,
    latencyMs: latencyMs(q),
    grade: gradeFromQuality(qualityOf(q)),
  };
}

// Writes the event and marks the question so it is never written twice. A store error is
// logged once and swallowed: losing an event must never break a quiz (T3-5).
export async function recordReview(quiz, q) {
  if (q.reviewRecorded) return;
  q.reviewRecorded = true;
  try {
    await store.appendReviewEvent(buildReviewEvent(quiz, q));
  } catch (err) {
    console.error(`[review-events] append failed | userId=${quiz.userId} | quizId=${quiz.quizId} | q=${q.id} | ${err.message}`);
  }
}
