import { callJSON, streamJSON } from './anthropic.js';
import { professorSystem, withSystemNote, specOrDefault } from './professor.js';

const SYSTEM = `You are an expert assessment designer trained in retrieval practice and elaborative interrogation. Generate questions that test deep understanding, not surface recall. Apply interleaving — never place consecutive questions on the same concept. Return ONLY a JSON array. No preamble, no markdown fences.`;

function askedLines(asked) {
  if (asked.length === 0) return '';
  const last = asked.at(-1);
  return `\nAlready asked in this quiz (do not repeat them; prefer other concepts when there are enough; your first question must not use conceptId "${last.conceptId}"):
${asked.map((q) => `- [${q.conceptId}] ${q.prompt}`).join('\n')}`;
}

// `spec`: the topic spec (lib/topicSpec.js); scenarios use its domain.
function buildUser({ count, distribution, freeFormPrompt, concepts, asked, spec }) {
  const distLine = Object.entries(distribution)
    .map(([k, v]) => `${Math.round(v * 100)}% ${k}`)
    .join(', ');
  const focus = freeFormPrompt ? `\nDirectional focus: "${freeFormPrompt}"` : '';
  return `Generate ${count} questions.
Type distribution: ${distLine}${focus}${askedLines(asked)}

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
- Scenario: realistic ${specOrDefault(spec).domain} context
- Explanation must be detailed enough to teach, not just confirm
- options field is required for mcq, omit or use empty array for other types`;
}

function hasConsecutiveDuplicates(questions) {
  for (let i = 1; i < questions.length; i++) {
    if (questions[i].conceptId === questions[i - 1].conceptId) return true;
  }
  return false;
}

// The visible part of a question being streamed (conceptId, type, prompt, options), once the
// model has moved on to `correctAnswer`; null before that or if the text can't be read.
export function visiblePart(text) {
  const cut = text.indexOf('"correctAnswer"');
  if (cut < 0) return null;
  const head = text.slice(0, cut).replace(/^\s*```(?:json)?\s*/i, '').replace(/^\s*\[/, '').replace(/,\s*$/, '');
  try {
    const q = JSON.parse(`${head}}`);
    const hasOptions = Array.isArray(q.options) && q.options.length >= 2;
    if (typeof q.prompt !== 'string' || (q.type === 'mcq' && !hasOptions)) return null;
    return q;
  } catch {
    return null;
  }
}

const ANSWER_KEY_SYSTEM = `You are an expert assessment designer. Write the answer key for the question given. Return ONLY JSON: {"correctAnswer": "...", "explanation": "..."}. No preamble, no markdown fences.`;

// The answer key for a question whose stream broke after it was shown.
async function writeAnswerKey(question, spec) {
  const user = `Question (${question.type}): ${question.prompt}
${question.options?.length ? `Options:\n${question.options.join('\n')}\n` : ''}
correctAnswer: for mcq the letter of the right option first (e.g. "B. ..."), otherwise the key points. explanation: why it is correct and why the wrong answers fail, detailed enough to teach.`;
  const key = await callJSON({ system: professorSystem(spec, ANSWER_KEY_SYSTEM), user, max_tokens: 1024 });
  if (typeof key?.correctAnswer !== 'string') throw new Error('questionGen: answer key without correctAnswer');
  return { ...question, correctAnswer: key.correctAnswer, explanation: key.explanation ?? '' };
}

// One question, streamed (DEC-059 §4). `shown` resolves with the visible part as soon as the
// model has written it, or with the whole question if that comes first; `full` resolves with
// the whole question, answer key included. If the stream fails after the question was shown,
// the answer key is written by a second call; if it fails before, the question is written again
// without streaming.
export function streamQuestion({ concepts, distribution, freeFormPrompt = null, spec = null }) {
  const user = buildUser({ count: 1, distribution, freeFormPrompt, concepts, asked: [], spec });
  let visible = null;
  let onShown;
  const shown = new Promise((resolve) => { onShown = resolve; });
  const full = streamJSON({
    system: professorSystem(spec, SYSTEM), user, max_tokens: 2048,
    onText: (text) => {
      if (visible) return;
      visible = visiblePart(text);
      if (visible) onShown(visible);
    },
  })
    .then((questions) => {
      const q = Array.isArray(questions) ? questions[0] : questions;
      if (typeof q?.prompt !== 'string' || typeof q.correctAnswer !== 'string') throw new Error('questionGen: incomplete question');
      if (visible && (q.prompt !== visible.prompt || JSON.stringify(q.options ?? []) !== JSON.stringify(visible.options ?? []))) {
        throw new Error('questionGen: question changed after it was shown');
      }
      return q;
    })
    .catch(async (err) => {
      console.warn(`[questionGen] streamed question failed, recovering | shown=${Boolean(visible)} | ${err.message}`);
      if (visible) return writeAnswerKey(visible, spec);
      const [q] = await generateQuestions({ concepts, count: 1, distribution, freeFormPrompt, spec });
      if (!q) throw new Error('questionGen: no question returned');
      return q;
    });
  return { shown: Promise.race([shown, full]), full };
}

// The type a one-question call asks for: the distribution's largest share.
export function leadType(distribution) {
  return Object.entries(distribution).sort((a, b) => b[1] - a[1])[0][0];
}

// Appends `rest` after `placed`, keeping the order except to avoid two consecutive questions on
// one concept: each step takes the first remaining question on a different concept, if any.
export function appendInterleaved(placed, rest) {
  const out = [...placed];
  const left = [...rest];
  while (left.length) {
    const i = left.findIndex((q) => q.conceptId !== out.at(-1)?.conceptId);
    out.push(left.splice(Math.max(i, 0), 1)[0]);
  }
  return out;
}

// `asked`: questions already in the quiz ({ conceptId, prompt }), which the new ones must not repeat.
export async function generateQuestions({ concepts, count, distribution, freeFormPrompt = null, asked = [], spec = null }) {
  const user = buildUser({ count, distribution, freeFormPrompt, concepts, asked, spec });
  const system = professorSystem(spec, SYSTEM);
  let questions = await callJSON({ system, user, max_tokens: 8192 });

  if (!Array.isArray(questions)) {
    throw new Error('questionGen: expected JSON array, got ' + typeof questions);
  }

  if (hasConsecutiveDuplicates(questions)) {
    const reinforced = withSystemNote(system, 'INTERLEAVING IS MANDATORY: no two consecutive questions may share the same conceptId. Reorder if needed.');
    questions = await callJSON({ system: reinforced, user, max_tokens: 8192 });
  }

  return questions;
}
