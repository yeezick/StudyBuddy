import { fsrs, generatorParameters, createEmptyCard, default_w, S_MIN, State } from 'ts-fsrs';

// FSRS-6 with default parameters (no per-user optimizer yet), 90% target retention,
// fuzz and short-term learning steps on (T4-1).
export const scheduler = fsrs(generatorParameters({
  request_retention: 0.9,
  enable_fuzz: true,
  enable_short_term: true,
}));

// The FSRS fields a card stores at the top level of `cards.state`.
const FIELDS = ['due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state', 'last_review'];

const iso = (d) => (d == null ? null : new Date(d).toISOString());

export function isFsrsCard(card) {
  return card != null && typeof card.stability === 'number';
}

// Stored card → ts-fsrs Card (dates as Date objects).
export function toFsrsCard(card) {
  const c = Object.fromEntries(FIELDS.map((k) => [k, card[k]]));
  c.due = new Date(card.due);
  c.last_review = card.last_review ? new Date(card.last_review) : undefined;
  return c;
}

// ts-fsrs Card → the JSON fields stored on the card.
export function fromFsrsCard(c) {
  const out = Object.fromEntries(FIELDS.map((k) => [k, c[k] ?? null]));
  out.due = iso(c.due);
  out.last_review = iso(c.last_review);
  return out;
}

// Port of fsrs-rs `memory_state_from_sm2` (R1b §A4). With sm2Retention = 0.9 the stability
// is the SM-2 interval itself; difficulty is solved from the ease factor.
export function memoryStateFromSm2(easeFactor, interval, sm2Retention = 0.9, w = default_w) {
  const decay = -w[20];
  const factor = 0.9 ** (1 / decay) - 1;
  const stability = (Math.max(interval, S_MIN) * factor) / (sm2Retention ** (1 / decay) - 1);
  const difficulty = 11 - (easeFactor - 1) / (Math.exp(w[8]) * stability ** -w[9] * Math.expm1((1 - sm2Retention) * w[10]));
  if (!Number.isFinite(stability) || !Number.isFinite(difficulty)) {
    throw new Error(`memoryStateFromSm2: invalid input (ease ${easeFactor}, interval ${interval})`);
  }
  return { stability, difficulty: Math.min(10, Math.max(1, difficulty)) };
}

// SM-2 state → the FSRS fields for the same card (T4-4). Never-reviewed → a new card.
// A reviewed card keeps its due date, so converted cards finish their current interval.
export function fsrsFieldsFromSm2(sm2, now = new Date()) {
  if (!sm2.lastReviewedAt) return fromFsrsCard(createEmptyCard(now));
  const { stability, difficulty } = memoryStateFromSm2(sm2.easeFactor, sm2.interval);
  return {
    due: iso(sm2.nextReviewAt ?? now),
    stability,
    difficulty,
    elapsed_days: 0,
    scheduled_days: sm2.interval,
    learning_steps: 0,
    reps: sm2.repetitions,
    lapses: 0,
    state: State.Review,
    last_review: iso(sm2.lastReviewedAt),
  };
}

// Recall probability of a stored FSRS card at `now`; null for a new card. ts-fsrs counts
// elapsed time in whole days, so a card reviewed earlier the same day reads 1.
export function retrievabilityAt(card, now = new Date()) {
  const c = toFsrsCard(card);
  return c.state === State.New ? null : scheduler.get_retrievability(c, now, false);
}

// One FSRS review. Retrievability is the recall probability at answer time (null for a new card).
export function reviewFsrs(card, grade, now) {
  const before = toFsrsCard(card);
  const retrievability = retrievabilityAt(card, now);
  const { card: after } = scheduler.next(before, now, grade);
  return { fields: fromFsrsCard(after), retrievability };
}
