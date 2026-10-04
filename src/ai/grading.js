import { callJSON } from './anthropic.js';
import { professorSystem } from './professor.js';

const SYSTEM = `You are a strict but fair grader. Be generous with partial credit when the student demonstrates understanding despite imprecise phrasing. Return ONLY JSON. No preamble.`;

function normalizeMCQ(answer) {
  if (typeof answer !== 'string') return '';
  return answer.trim().toUpperCase().charAt(0);
}

export function gradeMCQ(question, userAnswer) {
  const correctLetter = normalizeMCQ(question.correctAnswer);
  const userLetter = normalizeMCQ(userAnswer);
  const isCorrect = correctLetter !== '' && correctLetter === userLetter;
  return {
    isCorrect,
    score: isCorrect ? 1 : 0,
    feedback: question.explanation,
  };
}

// `spec`: the topic spec; the grader shares the question writer's cached professor prefix.
export async function gradeFreeText(question, userAnswer, { spec = null } = {}) {
  const user = `Question: ${question.prompt}
Expected: ${question.correctAnswer}
Student answer: ${userAnswer}

Return: { "isCorrect": bool, "score": 0.0-1.0, "feedback": "..." }`;

  const result = await callJSON({ system: professorSystem(spec, SYSTEM), user, max_tokens: 1024 });
  return {
    isCorrect: !!result.isCorrect,
    score: typeof result.score === 'number' ? result.score : 0,
    feedback: result.feedback ?? '',
  };
}
