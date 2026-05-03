import { callJSON } from './anthropic.js';

const SYSTEM = `You are an expert assessment designer trained in retrieval practice and elaborative interrogation. Generate questions that test deep understanding, not surface recall. Apply interleaving — never place consecutive questions on the same concept. Return ONLY a JSON array. No preamble, no markdown fences.`;

function buildUser({ count, distribution, freeFormPrompt, concepts }) {
  const distLine = Object.entries(distribution)
    .map(([k, v]) => `${Math.round(v * 100)}% ${k}`)
    .join(', ');
  const focus = freeFormPrompt ? `\nDirectional focus: "${freeFormPrompt}"` : '';
  return `Generate ${count} questions.
Type distribution: ${distLine}${focus}

Concepts:
${JSON.stringify(concepts)}

Each question object:
{
  "conceptId": "concept id",
  "type": "mcq" | "short_answer" | "explain" | "scenario",
  "prompt": "question text",
  "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correctAnswer": "correct answer or key points",
  "explanation": "why correct; why wrong answers fail",
  "difficulty": "recall" | "understanding" | "application"
}

Rules:
- MCQ distractors must be plausible
- Short answer: one definitive answer
- Explain: explain to a non-technical stakeholder
- Scenario: realistic PM context
- Explanation must be detailed enough to teach, not just confirm
- options field is required for mcq, omit or use empty array for other types`;
}

function hasConsecutiveDuplicates(questions) {
  for (let i = 1; i < questions.length; i++) {
    if (questions[i].conceptId === questions[i - 1].conceptId) return true;
  }
  return false;
}

export async function generateQuestions({ concepts, count, distribution, freeFormPrompt = null }) {
  const user = buildUser({ count, distribution, freeFormPrompt, concepts });
  let questions = await callJSON({ system: SYSTEM, user, max_tokens: 8192 });

  if (!Array.isArray(questions)) {
    throw new Error('questionGen: expected JSON array, got ' + typeof questions);
  }

  if (hasConsecutiveDuplicates(questions)) {
    const reinforced = `${SYSTEM}\n\nINTERLEAVING IS MANDATORY: no two consecutive questions may share the same conceptId. Reorder if needed.`;
    questions = await callJSON({ system: reinforced, user, max_tokens: 8192 });
  }

  return questions;
}
