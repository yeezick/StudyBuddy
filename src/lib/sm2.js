export function defaultMastery(conceptId) {
  return {
    conceptId,
    score: 0,
    easeFactor: 2.5,
    interval: 1,
    repetitions: 0,
    nextReviewAt: null,
    lastReviewedAt: null,
  };
}

export function updateMastery(mastery, qualityScore) {
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

  const nextReviewAt = new Date();
  nextReviewAt.setDate(nextReviewAt.getDate() + interval);

  return {
    ...mastery,
    easeFactor,
    interval,
    repetitions,
    score: Math.min(1.0, repetitions * 0.15),
    nextReviewAt: nextReviewAt.toISOString(),
    lastReviewedAt: new Date().toISOString(),
  };
}

export function qualityScoreFromMCQ(isCorrect, confidence) {
  if (!isCorrect) return 1;
  if (confidence === 1) return 3;
  if (confidence === 2) return 4;
  if (confidence === 3) return 5;
  return 3;
}

export function qualityScoreFromFreeText(aiScore, confidence) {
  let q = Math.floor(aiScore * 5);
  if (confidence === 1) q -= 1;
  return Math.max(0, Math.min(5, q));
}
