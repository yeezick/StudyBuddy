import { State } from 'ts-fsrs';
import { store } from '../store/index.js';
import { normalizeCard } from './mastery.js';

// Hypercorrection (DEC-058 §1): a wrong answer given with confidence Sure is re-checked once,
// by DM, ~10 min after the quiz ends. At most 3 per user per local day; the rest are dropped.
export const RETEST_DELAY_MS = 10 * 60 * 1000;
export const RETEST_DAILY_CAP = 3;
export const RETEST_TRIGGER = 'retest';

export function isConfidentMiss(q) {
  return q.isCorrect === false && q.confidenceRating === 3;
}

// The user's calendar day (YYYY-MM-DD) in their timezone; the cap resets at local midnight.
export function localDay(now = new Date(), timeZone = process.env.USER_TIMEZONE ?? 'America/Chicago') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Question type for the re-check, from the card after the miss: a card still in its first
// learning steps gets an MCQ (design §3: MCQ only for new cards); one that had graduated
// (Review/Relearning) gets free recall.
export function retestItemType(card, now = new Date()) {
  if (!card) return 'mcq';
  const { state } = normalizeCard(card, now);
  return state === State.New || state === State.Learning ? 'mcq' : 'short_answer';
}

const overflowLogged = new Set(); // `${userId}:${day}` — the overflow is logged once per day

// Reserves today's retest slot for this quiz × concept. True when a retest is (or already
// was) queued for it; false when the daily cap is full. Store errors drop the retest.
export async function claimRetest(quiz, q, now = new Date()) {
  const day = localDay(now);
  try {
    const result = await store.claimRetest(quiz.userId, day, `${quiz.quizId}:${q.conceptId}`, RETEST_DAILY_CAP);
    if (result !== 'over_cap') return true;
    const logKey = `${quiz.userId}:${day}`;
    if (!overflowLogged.has(logKey)) {
      overflowLogged.add(logKey);
      console.warn(`[retest] daily cap of ${RETEST_DAILY_CAP} reached | userId=${quiz.userId} | day=${day} | further retests today are dropped`);
    }
    return false;
  } catch (err) {
    console.error(`[retest] claim failed | userId=${quiz.userId} | quizId=${quiz.quizId} | ${err.message}`);
    return false;
  }
}
