import crypto from 'node:crypto';
import { store } from '../store/index.js';
import { boltApp } from './app.js';
import { getConcepts } from '../lib/concepts.js';
import { generateQuestions } from '../ai/questionGen.js';
import { gradeMCQ, gradeFreeText } from '../ai/grading.js';
import { matchConceptsToPrompt } from '../ai/conceptMatch.js';
import { reviewAnswer } from '../lib/reviewEvents.js';
import { isConfidentMiss, claimRetest, RETEST_TRIGGER } from '../lib/retest.js';
import { startExplainBack, clearExplainBack } from './explainBack.js';

const ON_DEMAND_DISTRIBUTION = { mcq: 0.6, short_answer: 0.2, explain: 0.2 };
const MAX_QUESTIONS = 10;

// Scoped pending free-text reply handlers: `${slackUserId}:${channelId}` → async fn(text)
const pendingReplies = new Map();

// Holds graded free-text results waiting for confidence tap: `${quizId}:${questionId}` → state
const pendingFreeTextConfidence = new Map();

// Callbacks invoked when a quiz completes: quizId → async fn(quiz)
const quizCompletionCallbacks = new Map();

// Listeners called once when any quiz ends: async fn(quiz, { reason: 'completed' | 'cancelled' })
const quizEndListeners = [];

// The handler waiting for this user's free-text answer in this channel, if any (consumed by messageRouter).
export function pendingQuizReply(slackUserId, channelId) {
  return pendingReplies.get(`${slackUserId}:${channelId}`) ?? null;
}

export function registerQuizCompletion(quizId, cb) {
  quizCompletionCallbacks.set(quizId, cb);
}

export function onQuizEnd(listener) {
  quizEndListeners.push(listener);
}

// A listener's failure is logged and never stops the quiz from finishing.
async function notifyQuizEnd(quiz, reason) {
  for (const listener of quizEndListeners) {
    try {
      await listener(quiz, { reason });
    } catch (err) {
      console.error(`[quiz] end listener failed | quizId=${quiz.quizId} | ${err.message}`);
    }
  }
}

// One extra feedback line for a confident miss (DEC-058 §1).
function confidentMissNote(q) {
  if (!isConfidentMiss(q) || q.retestQueued === undefined) return null;
  return q.retestQueued
    ? "\u26a0\ufe0f You were sure \u2014 worth a second look; I'll re-check this ~10 min after the quiz."
    : '\u26a0\ufe0f You were sure \u2014 worth a second look.';
}

const noteBlock = (q) => {
  const note = confidentMissNote(q);
  return note ? [{ type: 'section', text: { type: 'mrkdwn', text: note } }] : [];
};

const loadQuiz = (quizId) => store.getQuiz(quizId);
const saveQuiz = (quiz) => store.saveQuiz(quiz);

const OPTION_EMOJI = ['\u{1F1E6}', '\u{1F1E7}', '\u{1F1E8}', '\u{1F1E9}'];

function formatOptions(options) {
  return options.map((opt, i) => `${OPTION_EMOJI[i]} ${opt}`).join('\n\n');
}

function confidenceBlocks(quizId, question, questionNum, total) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Q${questionNum}/${total}:* ${question.prompt}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: formatOptions(question.options) },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '_Before you answer — how confident are you in this topic?_' },
    },
    {
      type: 'actions',
      block_id: `conf_${quizId}_${question.id}`,
      elements: ['Low', 'Medium', 'High'].map((label, i) => ({
        type: 'button',
        action_id: `quiz_confidence_${i + 1}`,
        text: { type: 'plain_text', text: label },
        value: JSON.stringify({ quizId, questionId: question.id, level: i + 1 }),
      })),
    },
  ];
}

function answerBlocks(quizId, question, questionNum, total, confidenceLevel) {
  const confLabel = ['Low', 'Medium', 'High'][confidenceLevel - 1];
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Q${questionNum}/${total}:* ${question.prompt}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: formatOptions(question.options) },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `_Confidence: ${confLabel} \u2713 \u2014 Now select your answer:_` },
    },
    {
      type: 'actions',
      block_id: `ans_${quizId}_${question.id}`,
      elements: question.options.map((_, i) => {
        const letter = String.fromCharCode(65 + i);
        return {
          type: 'button',
          action_id: `quiz_answer_${letter}`,
          text: { type: 'plain_text', text: letter },
          value: JSON.stringify({ quizId, questionId: question.id, letter, confidenceLevel }),
        };
      }),
    },
  ];
}

function resultBlocks(question, questionNum, total, gradeResult, confidenceLevel) {
  const confLabel = ['Low', 'Medium', 'High'][confidenceLevel - 1];
  const status = gradeResult.isCorrect ? '\u2705 Correct' : '\u274c Wrong';
  const correctNote = !gradeResult.isCorrect
    ? `  _(correct: ${question.correctAnswer.trim().charAt(0)})_`
    : '';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Q${questionNum}/${total}:* ${question.prompt}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Confidence: ${confLabel}  \u00b7  ${status}${correctNote}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `_${gradeResult.feedback}_` },
    },
    ...noteBlock(question),
  ];
}

function freetextConfidenceBlocks(quizId, question, questionNum, total) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_Q${questionNum}/${total} \u2014 Answer received. How confident were you?_`,
      },
    },
    {
      type: 'actions',
      block_id: `ftconf_${quizId}_${question.id}`,
      elements: ['Low', 'Medium', 'High'].map((label, i) => ({
        type: 'button',
        action_id: `quiz_freetext_confidence_${i + 1}`,
        text: { type: 'plain_text', text: label },
        value: JSON.stringify({ quizId, questionId: question.id, level: i + 1 }),
      })),
    },
  ];
}

function freetextResultBlocks(question, gradeResult, confidenceLevel) {
  const confLabel = ['Low', 'Medium', 'High'][confidenceLevel - 1];
  const status = gradeResult.isCorrect ? '\u2705 Correct' : '\u274c Incorrect';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Confidence: ${confLabel}  \u00b7  ${status}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `_${gradeResult.feedback}_` },
    },
    ...noteBlock(question),
  ];
}

// A wrong Sure answer reserves a retest, queued when the quiz ends (DEC-058 §1). A retest
// quiz never queues another one.
async function flagConfidentMiss(quiz, q) {
  if (quiz.trigger === RETEST_TRIGGER || !isConfidentMiss(q)) return;
  q.retestQueued = await claimRetest(quiz, q);
}

// Saves the quiz with the question's shownAt first, so answer latency survives a restart.
async function postQuestion(client, quiz, index) {
  const q = quiz.questions[index];
  const questionNum = index + 1;
  const total = quiz.questions.length;

  q.shownAt = new Date().toISOString();
  await saveQuiz(quiz);

  if (q.type === 'mcq') {
    await client.chat.postMessage({
      channel: quiz.slackChannelId,
      blocks: confidenceBlocks(quiz.quizId, q, questionNum, total),
      text: `Q${questionNum}/${total}: ${q.prompt}`,
    });
    return;
  }

  await client.chat.postMessage({
    channel: quiz.slackChannelId,
    text: `*Q${questionNum}/${total}:* ${q.prompt}\n\n_Reply with your answer._`,
  });

  const pendingKey = `${quiz.slackUserId}:${quiz.slackChannelId}`;
  pendingReplies.set(pendingKey, async (messageText) => {
    pendingReplies.delete(pendingKey);
    const answeredAt = new Date().toISOString(); // before grading, which takes seconds

    const freshQuiz = await loadQuiz(quiz.quizId);
    if (!freshQuiz || freshQuiz.status !== 'in_progress') return;

    const freshQ = freshQuiz.questions[index];
    const gradeResult = await gradeFreeText(freshQ, messageText);

    freshQ.userAnswer = messageText;
    freshQ.answeredAt = answeredAt;
    freshQ.isCorrect = gradeResult.isCorrect;
    freshQ.pointsEarned = gradeResult.score;
    // confidenceRating, scheduling and the review event wait for the confidence tap

    await saveQuiz(freshQuiz);

    await client.chat.postMessage({
      channel: freshQuiz.slackChannelId,
      blocks: freetextConfidenceBlocks(freshQuiz.quizId, freshQ, questionNum, total),
      text: `Q${questionNum}/${total} — Answer received. How confident were you?`,
    });

    pendingFreeTextConfidence.set(`${freshQuiz.quizId}:${freshQ.id}`, {
      gradeResult,
      quizId: freshQuiz.quizId,
      index,
    });
  });
}

async function completeQuiz(client, quiz) {
  quiz.status = 'completed';
  quiz.completedAt = new Date().toISOString();

  const answered = quiz.questions.filter((q) => q.isCorrect !== null);
  const correct = answered.filter((q) => q.isCorrect).length;
  const total = quiz.questions.length;
  quiz.score = Math.round((correct / total) * 100);

  await saveQuiz(quiz);

  const { userId } = quiz;

  for (const q of answered) {
    await reviewAnswer(quiz, q);
  }

  const concepts = await getConcepts(userId);
  const conceptMap = Object.fromEntries(concepts.map((c) => [c.id, c]));

  const correctQs = answered.filter((q) => q.isCorrect);
  const incorrectQs = answered.filter((q) => !q.isCorrect);

  const strongestId =
    correctQs.length > 0
      ? correctQs.sort((a, b) => (b.confidenceRating ?? 0) - (a.confidenceRating ?? 0))[0].conceptId
      : null;
  const weakestId = incorrectQs.length > 0 ? incorrectQs[0].conceptId : null;

  const strongestName = strongestId ? (conceptMap[strongestId]?.name ?? strongestId) : null;
  const weakestName = weakestId ? (conceptMap[weakestId]?.name ?? weakestId) : null;

  let text;
  if (quiz.trigger === RETEST_TRIGGER) {
    text = correct === total
      ? '\u2705 Re-check done \u2014 that one stuck this time.'
      : "\u{1F501} Re-check done \u2014 it'll come back sooner in your reviews.";
  } else {
    text = `\u2705 Quiz complete \u2014 ${quiz.score}/100  (${correct}/${total} correct)`;
    if (strongestName) text += `\n\nStrongest: ${strongestName}`;
    if (weakestName) text += `\nNeeds work: ${weakestName}`;
    text += `\n\n_Full results: will be available in Phase 3 web UI_`;
  }

  await client.chat.postMessage({ channel: quiz.slackChannelId, text });

  const cb = quizCompletionCallbacks.get(quiz.quizId);
  if (cb) {
    quizCompletionCallbacks.delete(quiz.quizId);
    await cb(quiz);
  } else if (quiz.trigger !== RETEST_TRIGGER) {
    // A session warm-up (it has a callback) carries on with the session instead.
    try {
      await startExplainBack(client, quiz);
    } catch (err) {
      console.error(`[explain-back] prompt failed | quizId=${quiz.quizId} | ${err.message}`);
    }
  }

  const historyEntry = {
    quizId: quiz.quizId,
    trigger: quiz.trigger,
    scope: quiz.input.scope ?? null,
    score: quiz.score,
    conceptIds: [...new Set(quiz.questions.map((q) => q.conceptId))],
    completedAt: quiz.completedAt,
  };
  await store.addHistory(userId, historyEntry);
  await store.clearActiveQuizId(userId);
  await notifyQuizEnd(quiz, 'completed');
}

async function selectConcepts(userId, input) {
  if (input.mode === 'free_form_prompt') {
    const all = await getConcepts(userId);
    const ids = await matchConceptsToPrompt(input.freeFormPrompt, all);
    return all.filter((c) => ids.includes(c.id));
  }
  if (input.mode === 'scope') {
    return getConcepts(userId, input.scope);
  }
  return getConcepts(userId);
}

export async function cancelQuiz(userId) {
  const quizId = await store.getActiveQuizId(userId);
  if (!quizId) return false;

  const quiz = await loadQuiz(quizId);
  if (!quiz || quiz.status !== 'in_progress') {
    await store.clearActiveQuizId(userId);
    return false;
  }

  // Graded answers still count: a free-text answer awaiting its confidence tap is recorded
  // with confidence null.
  for (const q of quiz.questions) {
    if (q.isCorrect === null) continue;
    await reviewAnswer(quiz, q);
  }

  pendingReplies.delete(`${quiz.slackUserId}:${quiz.slackChannelId}`);
  for (const key of pendingFreeTextConfidence.keys()) {
    if (key.startsWith(`${quizId}:`)) pendingFreeTextConfidence.delete(key);
  }

  await store.deleteQuiz(quizId);
  await store.clearActiveQuizId(userId);
  await notifyQuizEnd(quiz, 'cancelled');
  return true;
}

export async function startQuiz(client, userId, slackUserId, channelId, input, options = {}) {
  const {
    trigger = 'on_demand',
    concepts: conceptsOverride = null,
    distribution: distributionOverride = null,
    count: countOverride = null,
  } = options;

  const concepts = conceptsOverride ?? await selectConcepts(userId, input);
  if (concepts.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: 'No concepts found for that scope. Try `/quizinit` without arguments to quiz on all concepts.',
    });
    return null;
  }

  const count = countOverride ?? Math.min(MAX_QUESTIONS, concepts.length);
  const distribution = distributionOverride ?? ON_DEMAND_DISTRIBUTION;
  const rawQuestions = await generateQuestions({
    concepts,
    count,
    distribution,
    freeFormPrompt: input.freeFormPrompt ?? null,
  });

  const questions = rawQuestions.slice(0, count).map((q, i) => ({
    id: `q${i + 1}`,
    conceptId: q.conceptId,
    type: q.type,
    prompt: q.prompt,
    options: q.options ?? [],
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    userAnswer: null,
    isCorrect: null,
    confidenceRating: null,
    pointsEarned: null,
    scheduled: false,
    shownAt: null,
    answeredAt: null,
    reviewRecorded: false,
  }));

  const quizId = crypto.randomUUID();
  const quiz = {
    quizId,
    userId,
    trigger,
    input,
    questions,
    currentQuestionIndex: 0,
    status: 'in_progress',
    score: null,
    slackChannelId: channelId,
    slackUserId,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };

  await saveQuiz(quiz);
  await store.setActiveQuizId(userId, quizId);
  clearExplainBack(slackUserId, channelId);
  await postQuestion(client, quiz, 0);
  return quiz;
}

// Bolt action handlers, exported so tests can drive a quiz without Slack.
export async function onQuizConfidence({ ack, body, client }) {
  await ack();
  try {
    const { quizId, questionId, level } = JSON.parse(body.actions[0].value);
    const quiz = await loadQuiz(quizId);
    if (!quiz || quiz.status !== 'in_progress') return;

    const idx = quiz.questions.findIndex((q) => q.id === questionId);
    const q = quiz.questions[idx];
    if (!q || q.confidenceRating !== null) return;

    q.confidenceRating = level;
    await saveQuiz(quiz);

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: answerBlocks(quizId, q, idx + 1, quiz.questions.length, level),
      text: `Q${idx + 1}/${quiz.questions.length}: ${q.prompt}`,
    });
  } catch (err) {
    console.error(`[quiz_confidence] error | slackUser=${body.user?.id} | ${err.message}`);
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: '⚠️ Something went wrong. Please try again.' }).catch(() => {});
  }
}

export async function onQuizAnswer({ ack, body, client }) {
  await ack();
  try {
    const { quizId, questionId, letter, confidenceLevel } = JSON.parse(body.actions[0].value);
    const quiz = await loadQuiz(quizId);
    if (!quiz || quiz.status !== 'in_progress') return;

    const idx = quiz.questions.findIndex((q) => q.id === questionId);
    const q = quiz.questions[idx];
    if (!q || q.isCorrect !== null) return;

    if (q.confidenceRating === null) {
      await client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: 'Please select a confidence level before answering.',
      });
      return;
    }

    const answeredAt = new Date().toISOString();
    const gradeResult = gradeMCQ(q, letter);
    q.userAnswer = letter;
    q.answeredAt = answeredAt;
    q.isCorrect = gradeResult.isCorrect;
    q.pointsEarned = gradeResult.score;
    await reviewAnswer(quiz, q);
    await flagConfidentMiss(quiz, q);

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: resultBlocks(q, idx + 1, quiz.questions.length, gradeResult, confidenceLevel),
      text: `Q${idx + 1}/${quiz.questions.length}: ${q.prompt}`,
    });

    const nextIndex = idx + 1;
    if (nextIndex >= quiz.questions.length) {
      await saveQuiz(quiz);
      await completeQuiz(client, quiz);
    } else {
      quiz.currentQuestionIndex = nextIndex;
      await postQuestion(client, quiz, nextIndex);
    }
  } catch (err) {
    console.error(`[quiz_answer] error | slackUser=${body.user?.id} | ${err.message}`);
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: '⚠️ Something went wrong. Please try again.' }).catch(() => {});
  }
}

export async function onFreeTextConfidence({ ack, body, client }) {
  await ack();
  try {
    const { quizId, questionId, level } = JSON.parse(body.actions[0].value);

    const pendingKey = `${quizId}:${questionId}`;
    const pending = pendingFreeTextConfidence.get(pendingKey);
    if (!pending) return;
    pendingFreeTextConfidence.delete(pendingKey);

    const { gradeResult, index } = pending;

    const quiz = await loadQuiz(quizId);
    if (!quiz || quiz.status !== 'in_progress') return;

    const q = quiz.questions[index];
    q.confidenceRating = level;
    await reviewAnswer(quiz, q);
    await flagConfidentMiss(quiz, q);

    await saveQuiz(quiz);

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      blocks: freetextResultBlocks(q, gradeResult, level),
      text: gradeResult.isCorrect ? '\u2705 Correct' : '\u274c Incorrect',
    });

    const nextIndex = index + 1;
    if (nextIndex >= quiz.questions.length) {
      await completeQuiz(client, quiz);
    } else {
      quiz.currentQuestionIndex = nextIndex;
      await postQuestion(client, quiz, nextIndex);
    }
  } catch (err) {
    console.error(`[quiz_freetext_confidence] error | slackUser=${body.user?.id} | ${err.message}`);
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: '⚠️ Something went wrong. Please try again.' }).catch(() => {});
  }
}

export function registerQuizHandlers() {
  boltApp.action(/^quiz_confidence_\d$/, onQuizConfidence);
  boltApp.action(/^quiz_answer_[A-Z]$/, onQuizAnswer);
  boltApp.action(/^quiz_freetext_confidence_\d$/, onFreeTextConfidence);
}
