import { store } from '../store/index.js';
import { boltApp } from './app.js';
import { getConcepts } from '../lib/concepts.js';
import { gradeFreeText } from '../ai/grading.js';
import { callJSON } from '../ai/anthropic.js';
import { professorSystem } from '../ai/professor.js';
import { gradeFor } from '../lib/grade.js';
import { buildExplainBackEvent, buildExplainBackSkipEvent, latencyMs, isIdleLatency } from '../lib/reviewEvents.js';

// Explain-back (DEC-058 §2): when a quiz completes, one optional "why" prompt on the weakest
// concept answered in it. The reply is AI-graded and logged, a Skip is logged too (DEC-059 §3);
// the card is never rescheduled.

// An unanswered prompt stops claiming the user's messages after this long.
export const EXPLAIN_BACK_TTL_MS = 30 * 60 * 1000;

// The tailored question (DEC-059 §1) gets this long before the fixed template is used instead.
export const EXPLAIN_BACK_QUESTION_TIMEOUT_MS = 5000;

// `${slackUserId}:${channelId}` → { quizId, userId, trigger, conceptId, expected, spec, prompt, shownAt, ts }
const pending = new Map();

const keyFor = (slackUserId, channelId) => `${slackUserId}:${channelId}`;

// Weakest answered question: lowest grade; tie → longest latency, where an idle (> 5 min)
// or unknown latency counts as none; still tied → first asked.
export function pickWeakest(questions) {
  const answered = questions.filter((q) => q.isCorrect !== null && q.isCorrect !== undefined);
  const timed = (q) => {
    const ms = latencyMs(q);
    return ms == null || isIdleLatency(ms) ? -1 : ms;
  };
  let weakest = null;
  for (const q of answered) {
    if (!weakest) { weakest = q; continue; }
    const dg = gradeFor(q) - gradeFor(weakest);
    if (dg < 0 || (dg === 0 && timed(q) > timed(weakest))) weakest = q;
  }
  return weakest;
}

export const explainBackPrompt = (conceptName) =>
  `In 1–2 sentences, why does *${conceptName}* matter — what problem does it solve, and how?`;

const QUESTION_SYSTEM = `You write one short explain-back question for a learner who just finished a quiz. It asks them to explain in their own words why something about the concept is true or matters, and it must be answerable from the concept summary. Return ONLY JSON: {"question": "..."}. No preamble, no markdown fences.`;

// One short AI call writes the why-question from the concept summary and, when the learner
// missed it, the quiz question they missed. An error, a timeout or an odd reply falls back to
// the fixed template.
export async function tailoredExplainBackPrompt({ name, summary, missedPrompt = null }, { timeoutMs = EXPLAIN_BACK_QUESTION_TIMEOUT_MS, spec = null } = {}) {
  const missed = missedPrompt ? `\nThe learner just got this quiz question on it wrong: "${missedPrompt}"` : '';
  const user = `Concept: ${name}
Summary: ${summary}${missed}

Write one question that starts with "In 1–2 sentences, why" and ends with "?". At most 200 characters. Put the concept name in *single asterisks* if you use it.`;
  try {
    const reply = await callJSON({
      system: professorSystem(spec, QUESTION_SYSTEM), user, max_tokens: 200,
      requestOptions: { signal: AbortSignal.timeout(timeoutMs), maxRetries: 0 },
    });
    const question = typeof reply?.question === 'string' ? reply.question.trim() : '';
    if (!/^In 1\s*[–-]\s*2 sentences, why\b/i.test(question) || !question.endsWith('?') || question.length > 300) {
      throw new Error(`unexpected reply: ${JSON.stringify(reply).slice(0, 120)}`);
    }
    return question;
  } catch (err) {
    console.warn(`[explain-back] tailored question failed, using the template | ${err.message}`);
    return explainBackPrompt(name);
  }
}

function promptBlocks(quizId, conceptId, prompt) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `\u{1F4AD} *Optional explain-back.* ${prompt}\n_Reply here, or skip._` } },
    {
      type: 'actions',
      block_id: `explain_${quizId}`,
      elements: [{
        type: 'button',
        action_id: 'explain_back_skip',
        text: { type: 'plain_text', text: 'Skip' },
        value: JSON.stringify({ quizId, conceptId }),
      }],
    },
  ];
}

// The pending explain-back for this user and channel, if one is waiting (consumed by
// messageRouter). Returns the reply handler, or null.
export function pendingExplainBack(slackUserId, channelId, now = Date.now()) {
  const key = keyFor(slackUserId, channelId);
  const entry = pending.get(key);
  if (!entry) return null;
  if (now - Date.parse(entry.shownAt) > EXPLAIN_BACK_TTL_MS) {
    pending.delete(key);
    return null;
  }
  return (text, client) => answerExplainBack(client, key, entry, text);
}

// A new quiz takes over the channel; a prompt still open from the last one is dropped.
export function clearExplainBack(slackUserId, channelId) {
  pending.delete(keyFor(slackUserId, channelId));
}

export async function startExplainBack(client, quiz) {
  const weakest = pickWeakest(quiz.questions);
  if (!weakest) return;
  const concepts = await getConcepts(quiz.userId);
  const concept = concepts.find((c) => c.id === weakest.conceptId);
  const prompt = await tailoredExplainBackPrompt({
    name: concept?.name ?? weakest.conceptId,
    summary: concept?.summary ?? '',
    missedPrompt: weakest.isCorrect === false ? weakest.prompt : null,
  }, { spec: quiz.spec });

  const posted = await client.chat.postMessage({
    channel: quiz.slackChannelId,
    blocks: promptBlocks(quiz.quizId, weakest.conceptId, prompt),
    text: `Optional explain-back: ${prompt}`,
  });
  pending.set(keyFor(quiz.slackUserId, quiz.slackChannelId), {
    quizId: quiz.quizId,
    userId: quiz.userId,
    trigger: quiz.trigger,
    conceptId: weakest.conceptId,
    expected: concept?.summary ?? '',
    spec: quiz.spec ?? null,
    prompt,
    shownAt: new Date().toISOString(),
    ts: posted?.ts ?? null,
  });
}

async function answerExplainBack(client, key, entry, text) {
  pending.delete(key);
  const answeredAt = new Date().toISOString(); // before grading, which takes seconds
  const channel = key.slice(key.indexOf(':') + 1);

  const result = await gradeFreeText({ prompt: entry.prompt, correctAnswer: entry.expected }, text, { spec: entry.spec });
  const pct = Math.round(result.score * 100);
  await client.chat.postMessage({
    channel,
    text: `${result.isCorrect ? '✅' : '\u{1F7E1}'} Explain-back: ${pct}/100\n_${result.feedback}_`,
  });

  try {
    await store.appendReviewEvent(buildExplainBackEvent({ ...entry, text, answeredAt, result }));
  } catch (err) {
    console.error(`[explain-back] append failed | userId=${entry.userId} | quizId=${entry.quizId} | ${err.message}`);
  }
}

export async function onExplainBackSkip({ ack, body, client }) {
  await ack();
  try {
    const key = keyFor(body.user.id, body.channel.id);
    const { quizId } = JSON.parse(body.actions[0].value);
    const entry = pending.get(key);
    if (entry?.quizId === quizId) {
      pending.delete(key);
      // A prompt already past its 30 min lapsed: that logs nothing, so a late Skip doesn't either.
      const skippedAt = new Date().toISOString();
      if (Date.parse(skippedAt) - Date.parse(entry.shownAt) <= EXPLAIN_BACK_TTL_MS) {
        await store.appendReviewEvent(buildExplainBackSkipEvent({ ...entry, skippedAt }))
          .catch((err) => console.error(`[explain-back] skip append failed | userId=${entry.userId} | quizId=${quizId} | ${err.message}`));
      }
    }
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '_Explain-back skipped._' } }],
      text: 'Explain-back skipped.',
    });
  } catch (err) {
    console.error(`[explain_back_skip] error | slackUser=${body.user?.id} | ${err.message}`);
  }
}

export function registerExplainBackHandlers() {
  boltApp.action('explain_back_skip', onExplainBackSkip);
}
