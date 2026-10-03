import { store } from '../store/index.js';
import { defaultMastery, updateMastery, scoreFor, QUALITY_FOR_GRADE } from './sm2.js';
import { isFsrsCard, fsrsFieldsFromSm2, reviewFsrs } from './fsrs.js';

// A card (`cards.state`) holds the FSRS fields at the top level, the SM-2 state under `sm2`,
// and the fields every reader uses: score, nextReviewAt (= the active scheduler's due),
// lastReviewedAt. Cards written before FSRS are flat SM-2 objects; they are converted the
// next time they are scheduled (T4-4), never in bulk.

let warnedScheduler = false;
export function schedulerName(env = process.env) {
  const value = env.SCHEDULER || 'fsrs';
  if (value === 'fsrs' || value === 'sm2') return value;
  if (!warnedScheduler) {
    warnedScheduler = true;
    console.error(`[scheduler] unknown SCHEDULER=${value}; using fsrs`);
  }
  return 'fsrs';
}

export async function getMastery(userId, conceptId) {
  const [card] = await store.getCards(userId, [conceptId]);
  return card ?? defaultMastery(conceptId);
}

export async function setMastery(userId, mastery) {
  await store.saveCard(userId, mastery);
}

export async function getAllMastery(userId, conceptIds) {
  const cards = await store.getCards(userId, conceptIds);
  return conceptIds.map((id, i) => cards[i] ?? defaultMastery(id));
}

function sm2Of(card) {
  const src = card.sm2 ?? card;
  const { easeFactor, interval, repetitions, nextReviewAt, lastReviewedAt } = src;
  return { easeFactor, interval, repetitions, nextReviewAt: nextReviewAt ?? null, lastReviewedAt: lastReviewedAt ?? null };
}

// A card in the current shape, converting a flat SM-2 card on the way (due date kept).
export function normalizeCard(card, now = new Date()) {
  if (isFsrsCard(card)) return card;
  const sm2 = sm2Of(card);
  return {
    conceptId: card.conceptId,
    scheduler: 'fsrs',
    score: card.score ?? scoreFor(sm2.repetitions),
    nextReviewAt: card.nextReviewAt ?? null,
    lastReviewedAt: card.lastReviewedAt ?? null,
    ...fsrsFieldsFromSm2(sm2, now),
    sm2,
    convertedFromSm2At: now.toISOString(),
  };
}

// Pure: one review of `card` with `grade` (1–4) at `now`. SM-2 is always updated under
// `sm2`; FSRS only when it is the active scheduler, so a rollback never runs FSRS code.
export function reviewCard(card, grade, now = new Date(), scheduler = schedulerName()) {
  const prev = scheduler === 'fsrs' ? normalizeCard(card, now) : card;
  const prevSm2 = sm2Of(prev);
  const { score: _s, ...sm2Next } = updateMastery(prevSm2, QUALITY_FOR_GRADE[grade], now);

  const next = {
    ...prev,
    scheduler,
    sm2: sm2Next,
    score: scoreFor(sm2Next.repetitions),
    lastReviewedAt: now.toISOString(),
  };
  let retrievability = null;
  if (scheduler === 'fsrs') {
    const result = reviewFsrs(prev, grade, now);
    Object.assign(next, result.fields);
    retrievability = result.retrievability;
    next.nextReviewAt = result.fields.due;
  } else {
    // Rollback: drop flat SM-2 fields from an unconverted card; FSRS fields (if any) stay as they were.
    for (const k of ['easeFactor', 'interval', 'repetitions']) delete next[k];
    next.nextReviewAt = sm2Next.nextReviewAt;
  }
  return { prev, next, retrievability };
}

// Schedules one graded answer and saves the card. Returns the transition for the review event.
export async function applyQuestionResult(userId, conceptId, grade, now = new Date()) {
  const current = await getMastery(userId, conceptId);
  const transition = reviewCard(current, grade, now);
  await setMastery(userId, transition.next);
  return transition;
}
