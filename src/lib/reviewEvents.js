import { store } from '../store/index.js';
import { gradeFor } from './grade.js';
import { applyQuestionResult } from './mastery.js';

// Every graded quiz answer is scheduled once and becomes one append-only review event
// (design §10 slices 4 and 9). The event carries the card before and after (DEC-054) so the
// log can be replayed by a future optimizer.

export function latencyMs(q) {
  if (!q.shownAt || !q.answeredAt) return null;
  const ms = Date.parse(q.answeredAt) - Date.parse(q.shownAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

// Card state as logged on an event: the card without its id.
const snapshot = ({ conceptId: _c, ...state }) => state;

export function buildReviewEvent(quiz, q, transition = null) {
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
    grade: gradeFor(q),
    prevState: transition ? snapshot(transition.prev) : null,
    nextState: transition
      ? { ...snapshot(transition.next), retrievability_at_review: transition.retrievability }
      : null,
  };
}

// Schedules the answer's card, then writes its event; both are marked on the question so
// neither happens twice. A scheduling error propagates (the handler reports it and the
// answer can be retried). An event store error is logged once and swallowed: losing an
// event must never break a quiz (T3-5).
// `sm2Applied` is the pre-FSRS name of `scheduled`, still honoured for quizzes in flight.
export async function reviewAnswer(quiz, q) {
  let transition = null;
  if (!q.scheduled && !q.sm2Applied) {
    const now = q.answeredAt ? new Date(q.answeredAt) : new Date();
    transition = await applyQuestionResult(quiz.userId, q.conceptId, gradeFor(q), now);
    q.scheduled = true;
  }
  if (q.reviewRecorded) return;
  q.reviewRecorded = true;
  try {
    await store.appendReviewEvent(buildReviewEvent(quiz, q, transition));
  } catch (err) {
    console.error(`[review-events] append failed | userId=${quiz.userId} | quizId=${quiz.quizId} | q=${q.id} | ${err.message}`);
  }
}
