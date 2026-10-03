// SM-2, kept as the rollback scheduler (SCHEDULER=sm2) and shadow-updated under `card.sm2`
// on every review so a rollback resumes from current state (T4-7).

export function defaultMastery(conceptId) {
  return {
    conceptId,
    easeFactor: 2.5,
    interval: 1,
    repetitions: 0,
    nextReviewAt: null,
    lastReviewedAt: null,
  };
}

// The 1–4 grade (gradeFor) → the SM-2 quality it stands for. Again resets the card.
export const QUALITY_FOR_GRADE = { 1: 1, 2: 3, 3: 4, 4: 5 };

// The pre-FSRS mastery score; /mastery shows it only under SCHEDULER=sm2 (masteryScore in
// mastery.js, DEC-056). Never stored on a card.
export function scoreFor(repetitions) {
  return Math.min(1.0, repetitions * 0.15);
}

export function updateMastery(mastery, qualityScore, now = new Date()) {
  let { easeFactor, interval, repetitions } = mastery;

  if (qualityScore < 3) {
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);
    repetitions += 1;
  }

  easeFactor = Math.max(
    1.3,
    easeFactor + 0.1 - (5 - qualityScore) * (0.08 + (5 - qualityScore) * 0.02)
  );

  const nextReviewAt = new Date(now);
  nextReviewAt.setDate(nextReviewAt.getDate() + interval);

  return {
    ...mastery,
    easeFactor,
    interval,
    repetitions,
    score: scoreFor(repetitions),
    nextReviewAt: nextReviewAt.toISOString(),
    lastReviewedAt: new Date(now).toISOString(),
  };
}
