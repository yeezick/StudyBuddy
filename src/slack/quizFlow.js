import crypto from 'node:crypto';
import { store } from '../store/index.js';
import { boltApp } from './app.js';
import { getConcepts } from '../lib/concepts.js';
import { generateQuestions, streamQuestion, leadType, appendInterleaved } from '../ai/questionGen.js';
import { gradeMCQ, gradeFreeText } from '../ai/grading.js';
import { matchConceptsToPrompt } from '../ai/conceptMatch.js';
import { reviewAnswer } from '../lib/reviewEvents.js';
import { CONFIDENCE_LABELS } from '../lib/grade.js';
import { isConfidentMiss, claimRetest, RETEST_TRIGGER } from '../lib/retest.js';
import { startExplainBack, clearExplainBack } from './explainBack.js';
import { getAllMastery, isDue, masteryScore } from '../lib/mastery.js';
import { getTopicSpec, normalizeSpec } from '../lib/topicSpec.js';
import { templateFor } from '../lib/templates.js';
import { DEFAULT_TOPIC_ID } from '../store/topics.js';

// On-demand quizzes use the topic template's item mix; ai-pm's Knowledge template has today's.
const MAX_QUESTIONS = 10;

// Scoped pending free-text reply handlers: `${slackUserId}:${channelId}` → async fn(text)
const pendingReplies = new Map();

// Holds graded free-text results waiting for confidence tap: `${quizId}:${questionId}` → state
const pendingFreeTextConfidence = new Map();

// Callbacks invoked when a quiz completes: quizId → async fn(quiz)
const quizCompletionCallbacks = new Map();

// Questions after Q1, still being written (DEC-059 §4): quizId → batches in quiz order,
// each { promise → { questions } | { error }, planned, done }
const pendingQuestions = new Map();

// Q1's answer key, still streaming after Q1 was posted: quizId → Promise<question>
const pendingAnswerKeys = new Map();

// MCQ answers being handled, `${quizId}:${questionId}`: a second tap while the first waits
// (for the answer key or the next question) is ignored.
const answering = new Set();

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

// A quiz started before topics (T6-1) has no spec; it ran as ai-pm.
const specOf = (quiz) => quiz.spec ?? normalizeSpec({ id: quiz.topicId ?? DEFAULT_TOPIC_ID });
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
      elements: CONFIDENCE_LABELS.map((label, i) => ({
        type: 'button',
        action_id: `quiz_confidence_${i + 1}`,
        text: { type: 'plain_text', text: label },
        value: JSON.stringify({ quizId, questionId: question.id, level: i + 1 }),
      })),
    },
  ];
}

function answerBlocks(quizId, question, questionNum, total, confidenceLevel) {
  const confLabel = CONFIDENCE_LABELS[confidenceLevel - 1];
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
  const confLabel = CONFIDENCE_LABELS[confidenceLevel - 1];
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
      elements: CONFIDENCE_LABELS.map((label, i) => ({
        type: 'button',
        action_id: `quiz_freetext_confidence_${i + 1}`,
        text: { type: 'plain_text', text: label },
        value: JSON.stringify({ quizId, questionId: question.id, level: i + 1 }),
      })),
    },
  ];
}

function freetextResultBlocks(question, gradeResult, confidenceLevel) {
  const confLabel = CONFIDENCE_LABELS[confidenceLevel - 1];
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
  const total = totalOf(quiz);

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
    await ensureAnswerKey(freshQuiz, freshQ);
    const gradeResult = await gradeFreeText(freshQ, messageText, { spec: specOf(freshQuiz) });

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
  pendingQuestions.delete(quiz.quizId);
  pendingAnswerKeys.delete(quiz.quizId);
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

function toQuizQuestion(q, i) {
  return {
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
  };
}

// The "total" in "Qn/total": questions in hand plus those still being written.
const totalOf = (quiz) => quiz.total ?? quiz.questions.length;

// Waits, if needed, for the answer key of a question posted while it was still streaming.
async function ensureAnswerKey(quiz, q) {
  if (typeof q.correctAnswer === 'string') return;
  const pendingKey = pendingAnswerKeys.get(quiz.quizId);
  if (!pendingKey) throw new Error(`answer key lost | quizId=${quiz.quizId} | q=${q.id}`);
  const full = await pendingKey;
  q.correctAnswer = full.correctAnswer;
  q.explanation = full.explanation;
}

function plannedTotal(quiz) {
  const batches = pendingQuestions.get(quiz.quizId) ?? [];
  return quiz.questions.length + batches.reduce((n, batch) => n + batch.planned, 0);
}

function startBatch(args) {
  const batch = { planned: args.count, done: false };
  batch.promise = generateQuestions(args)
    .then((qs) => ({ questions: qs.slice(0, args.count) }), (error) => ({ error }))
    .finally(() => { batch.done = true; });
  return batch;
}

// Adds the next batch written in the background once the quiz needs its next question,
// waiting for it if needed. A failed batch is skipped; when none is left (all failed, or lost
// to a restart) the quiz ends with the questions it has.
async function fillQuestions(client, quiz, nextIndex) {
  const batches = pendingQuestions.get(quiz.quizId) ?? [];
  let failed = false;
  while (nextIndex >= quiz.questions.length && batches.length) {
    const batch = batches[0];
    if (!batch.done) {
      await client.chat.postMessage({ channel: quiz.slackChannelId, text: '_Writing the next question\u2026_' });
    }
    const { questions, error } = await batch.promise;
    if (batches[0] === batch) batches.shift();
    if (error) {
      failed = true;
      console.error(`[quiz] background questions failed | quizId=${quiz.quizId} | ${error.message}`);
      continue;
    }
    const added = appendInterleaved(quiz.questions, questions).slice(quiz.questions.length);
    quiz.questions.push(...added.map((q, i) => toQuizQuestion(q, quiz.questions.length + i)));
  }
  if (batches.length === 0) pendingQuestions.delete(quiz.quizId);
  quiz.total = plannedTotal(quiz);
  if (failed && nextIndex >= quiz.questions.length) {
    await client.chat.postMessage({
      channel: quiz.slackChannelId,
      text: "\u26a0\ufe0f Couldn't write the rest of this quiz \u2014 finishing with what you've answered.",
    });
  }
}

// Concepts for the questions written alone, so the batch written alongside them can leave
// them out. Only when every question can have its own concept. DEC-060 §1: due cards first,
// then the weakest (lowest mastery); random only breaks ties. `cards[i]` is concepts[i]'s card.
export function pickLeads(concepts, count, { cards = [], now = new Date(), n = 2, random = Math.random } = {}) {
  if (count < 2 || concepts.length < count) return [];
  const ranked = concepts.map((c, i) => ({
    c, due: isDue(cards[i], now) ? 0 : 1, mastery: masteryScore(cards[i], now), tie: random(),
  }));
  ranked.sort((a, b) => a.due - b.due || a.mastery - b.mastery || a.tie - b.tie);
  return ranked.slice(0, Math.min(n, count)).map((r) => r.c);
}

// One item type drawn from the distribution (DEC-060 §2: Q2 follows the normal mix).
export function sampleType(distribution, random = Math.random) {
  const entries = Object.entries(distribution);
  const total = entries.reduce((sum, [, share]) => sum + share, 0);
  let x = random() * total;
  for (const [type, share] of entries) {
    x -= share;
    if (x < 0) return type;
  }
  return entries.at(-1)[0];
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
  pendingQuestions.delete(quizId);
  pendingAnswerKeys.delete(quizId);
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
    requestedAt = Date.now(), // when the user asked (command received), for quiz_ready_ms
    topicId = DEFAULT_TOPIC_ID,
  } = options;

  // Concepts still come from the user's library; the topic sets the professor (T6-1).
  const spec = await getTopicSpec(store, topicId);
  const concepts = conceptsOverride ?? await selectConcepts(userId, input);
  if (concepts.length === 0) {
    await client.chat.postMessage({
      channel: channelId,
      text: 'No concepts found for that scope. Try `/quizinit` without arguments to quiz on all concepts.',
    });
    return null;
  }

  const count = countOverride ?? Math.min(MAX_QUESTIONS, concepts.length);
  const distribution = distributionOverride ?? templateFor(spec.template).itemMix;
  const freeFormPrompt = input.freeFormPrompt ?? null;
  // Q1 is the mix's largest share (fast to answer, DEC-059 §4); Q2 is drawn from the mix.
  const solo = { count: 1, distribution: { [leadType(distribution)]: 1 }, freeFormPrompt, spec };
  const second = { ...solo, distribution: { [sampleType(distribution)]: 1 } };

  // Q1 posts in seconds (DEC-059 §4): Q1 and Q2 are each written alone, on concepts picked
  // here, while the rest are written at the same time from the other concepts. When the
  // concepts are too few to keep apart, Q1 is written first and the rest are told what it asked.
  const cards = count >= 2 && concepts.length >= count ? await getAllMastery(userId, concepts.map((c) => c.id)) : [];
  const leads = pickLeads(concepts, count, { cards });
  const quizId = crypto.randomUUID();
  const batches = [];
  const firstConcepts = leads.length ? [leads[0]] : concepts;
  // Streamed: Q1 is posted once its prompt and options are written; its answer key follows.
  const firstCall = streamQuestion({ ...solo, concepts: firstConcepts });
  if (leads.length) {
    const others = concepts.filter((c) => !leads.includes(c));
    if (leads[1]) batches.push(startBatch({ ...second, concepts: [leads[1]] }));
    if (count > leads.length) batches.push(startBatch({ concepts: others, count: count - leads.length, distribution, freeFormPrompt, spec }));
  }
  if (batches.length) pendingQuestions.set(quizId, batches);

  let first;
  try {
    first = await firstCall.shown;
  } catch (err) {
    pendingQuestions.delete(quizId);
    throw err;
  }
  if (typeof first.correctAnswer !== 'string') {
    firstCall.full.catch(() => {}); // a failure surfaces when the answer key is needed
    pendingAnswerKeys.set(quizId, firstCall.full);
  }
  if (!leads.length && count > 1) {
    pendingQuestions.set(quizId, [startBatch({ concepts, count: count - 1, distribution, freeFormPrompt, asked: [first], spec })]);
  }

  const quiz = {
    quizId,
    userId,
    trigger,
    input,
    topicId: spec.id,
    spec,
    retentionTarget: templateFor(spec.template).retentionTarget,
    questions: [toQuizQuestion(first, 0)],
    total: count,
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
  console.log(`[quiz] ready | quizId=${quizId} | trigger=${trigger} | quiz_ready_ms=${Date.now() - requestedAt}`);
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
      blocks: answerBlocks(quizId, q, idx + 1, totalOf(quiz), level),
      text: `Q${idx + 1}/${totalOf(quiz)}: ${q.prompt}`,
    });
  } catch (err) {
    console.error(`[quiz_confidence] error | slackUser=${body.user?.id} | ${err.message}`);
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: '⚠️ Something went wrong. Please try again.' }).catch(() => {});
  }
}

export async function onQuizAnswer({ ack, body, client }) {
  await ack();
  let lockKey = null;
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

    if (answering.has(`${quizId}:${questionId}`)) return;
    lockKey = `${quizId}:${questionId}`;
    answering.add(lockKey);

    const answeredAt = new Date().toISOString();
    await ensureAnswerKey(quiz, q);
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
      blocks: resultBlocks(q, idx + 1, totalOf(quiz), gradeResult, confidenceLevel),
      text: `Q${idx + 1}/${totalOf(quiz)}: ${q.prompt}`,
    });

    const nextIndex = idx + 1;
    if (nextIndex >= quiz.questions.length) {
      await saveQuiz(quiz); // records the answer before a possibly long wait for the next questions
      await fillQuestions(client, quiz, nextIndex);
    }
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
  } finally {
    if (lockKey) answering.delete(lockKey);
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
    if (nextIndex >= quiz.questions.length) await fillQuestions(client, quiz, nextIndex);
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
