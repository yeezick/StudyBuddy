// Confidence buttons, by stored value 1/2/3 (DEC-059 §2).
export const CONFIDENCE_LABELS = ['Guess', 'Medium', 'Sure'];

// The one grade (DEC-053) used by both the scheduler and the review event.
// 1 Again · 2 Hard · 3 Good · 4 Easy — the same numbers as ts-fsrs `Rating`.
// Free-text `score` (the AI's points) is logged on the event, never used here.
export function gradeFor(q) {
  if (!q.isCorrect) return 1;
  if (q.confidenceRating === 1) return 2; // Guess
  if (q.confidenceRating === 3) return 4; // Sure
  return 3; // 2, or no confidence tap
}
