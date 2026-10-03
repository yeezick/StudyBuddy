import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubRedis } from './helpers/fakeRedis.js';

// The Anthropic SDK captures fetch when the client is built (at import), so the stub goes in
// before the app modules load. Each Anthropic call takes the next queued JSON reply.
const anthropicReplies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.anthropic.com')) return realFetch(url, init);
  if (anthropicReplies.length === 0) throw new Error('test: unexpected Anthropic call');
  const message = {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
    content: [{ type: 'text', text: JSON.stringify(anthropicReplies.shift()) }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { store } = await import('../src/store/index.js');
const { startQuiz, cancelQuiz, pendingQuizReply, onQuizConfidence, onQuizAnswer, onFreeTextConfidence } =
  await import('../src/slack/quizFlow.js');
const { gradeFromQuality } = await import('../src/lib/reviewEvents.js');

const USER = 'test-user'; // SINGLE_USER_ID in helpers/env.js; its library topic is ai-pm
const SLACK_USER = 'UOWNER';
const CHANNEL = 'D1';
const CONCEPTS = [{ id: 'c1', name: 'One', summary: 's' }, { id: 'c2', name: 'Two', summary: 's' }];

const mcq = (conceptId, correct) => ({
  conceptId, type: 'mcq', prompt: `About ${conceptId}?`, options: ['A. a', 'B. b', 'C. c', 'D. d'],
  correctAnswer: correct, explanation: 'because',
});
const shortAnswer = (conceptId) => ({ conceptId, type: 'short_answer', prompt: `Explain ${conceptId}`, correctAnswer: 'key points', explanation: 'because' });

function fakeClient() {
  const posted = [];
  const chat = {
    postMessage: async (msg) => { posted.push(msg); return { ok: true, ts: String(posted.length) }; },
    update: async () => ({ ok: true }),
    postEphemeral: async (msg) => { posted.push({ ephemeral: true, ...msg }); return { ok: true }; },
  };
  return { chat, posted };
}

const action = (value) => ({
  ack: async () => {},
  body: { actions: [{ value: JSON.stringify(value) }], channel: { id: CHANNEL }, message: { ts: '1' }, user: { id: SLACK_USER } },
});

// Moves a question's persisted shownAt back, as if it had been on screen that long.
async function backdateShown(quizId, index, ms) {
  const quiz = await store.getQuiz(quizId);
  quiz.questions[index].shownAt = new Date(Date.now() - ms).toISOString();
  await store.saveQuiz(quiz);
}

let fake;
let errors;
const realConsoleError = console.error;
beforeEach(() => {
  fake = stubRedis();
  anthropicReplies.length = 0;
  errors = [];
  console.error = (...args) => errors.push(args.join(' '));
});
afterEach(() => {
  console.error = realConsoleError;
  fake.restore();
});

test('T3: grade maps SM-2 quality onto 1–4', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(gradeFromQuality), [1, 1, 1, 2, 3, 4]);
});

test('T3-1/2: a full MCQ quiz writes one event per answer with confidence, grade and latency', async () => {
  const { chat } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B'), mcq('c2', 'C')]);
  const quiz = await startQuiz({ chat }, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2 });

  // Each handler reloads the quiz from the store, so latency comes from the persisted shownAt.
  await backdateShown(quiz.quizId, 0, 5000);
  await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 3 }), client: { chat } });
  await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId: 'q1', letter: 'B', confidenceLevel: 3 }), client: { chat } });

  await backdateShown(quiz.quizId, 1, 2000);
  await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q2', level: 1 }), client: { chat } });
  await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId: 'q2', letter: 'A', confidenceLevel: 1 }), client: { chat } });

  const events = await store.getReviewEvents(USER);
  assert.equal(events.length, 2, 'one event per answer, none added at completion');
  const [second, first] = events;
  const pick = ({ userId, conceptId, topicId, trigger, quizId, itemType, correct, score, confidence, grade }) =>
    ({ userId, conceptId, topicId, trigger, quizId, itemType, correct, score, confidence, grade });
  assert.deepEqual(pick(first), {
    userId: USER, conceptId: 'c1', topicId: 'ai-pm', trigger: 'on_demand', quizId: quiz.quizId,
    itemType: 'mcq', correct: true, score: 1, confidence: 3, grade: 4,
  });
  assert.deepEqual(pick(second), {
    userId: USER, conceptId: 'c2', topicId: 'ai-pm', trigger: 'on_demand', quizId: quiz.quizId,
    itemType: 'mcq', correct: false, score: 0, confidence: 1, grade: 1,
  });
  assert.ok(first.latencyMs >= 5000 && first.latencyMs < 7000, `latency ${first.latencyMs}`);
  assert.ok(second.latencyMs >= 2000 && second.latencyMs < 4000, `latency ${second.latencyMs}`);
  assert.ok(Date.parse(first.ts) <= Date.parse(second.ts));

  // The quiz still completed normally.
  assert.equal((await store.getHistory(USER, 1))[0].quizId, quiz.quizId);
  assert.equal(await store.getActiveQuizId(USER), null);
  assert.deepEqual(errors, []);
});

test('T3-1/2: a free-text quiz writes its event on the confidence tap, latency up to the reply', async () => {
  const { chat } = fakeClient();
  anthropicReplies.push([shortAnswer('c1'), shortAnswer('c2')]);
  const quiz = await startQuiz({ chat }, USER, SLACK_USER, CHANNEL, {}, {
    trigger: 'scheduled_ping', concepts: CONCEPTS, count: 2, distribution: { short_answer: 1 },
  });

  await backdateShown(quiz.quizId, 0, 3000);
  anthropicReplies.push({ isCorrect: true, score: 0.9, feedback: 'good' });
  await pendingQuizReply(SLACK_USER, CHANNEL)('my answer one');
  assert.deepEqual(await store.getReviewEvents(USER), [], 'no event until confidence is picked');
  await onFreeTextConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 3 }), client: { chat } });

  anthropicReplies.push({ isCorrect: false, score: 0.2, feedback: 'not quite' });
  await pendingQuizReply(SLACK_USER, CHANNEL)('my answer two');
  await onFreeTextConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q2', level: 1 }), client: { chat } });

  const [second, first] = await store.getReviewEvents(USER);
  assert.equal((await store.getReviewEvents(USER)).length, 2);
  assert.deepEqual(
    [first, second].map(({ conceptId, trigger, itemType, correct, score, confidence, grade }) =>
      ({ conceptId, trigger, itemType, correct, score, confidence, grade })),
    [
      // 0.9 × 5 → quality 4 → Good
      { conceptId: 'c1', trigger: 'scheduled_ping', itemType: 'free_text', correct: true, score: 0.9, confidence: 3, grade: 3 },
      // 0.2 × 5 = 1, minus 1 for low confidence → quality 0 → Again
      { conceptId: 'c2', trigger: 'scheduled_ping', itemType: 'free_text', correct: false, score: 0.2, confidence: 1, grade: 1 },
    ],
  );
  assert.ok(first.latencyMs >= 3000 && first.latencyMs < 5000, `latency ${first.latencyMs}`);
  assert.equal((await store.getHistory(USER, 1))[0].quizId, quiz.quizId);
  assert.deepEqual(errors, []);
});

test('T3-1: cancelling records graded answers once; a free-text answer without a tap has no confidence', async () => {
  const { chat } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B'), shortAnswer('c2'), mcq('c1', 'A')]);
  const quiz = await startQuiz({ chat }, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });

  await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 2 }), client: { chat } });
  await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId: 'q1', letter: 'B', confidenceLevel: 2 }), client: { chat } });
  anthropicReplies.push({ isCorrect: true, score: 0.8, feedback: 'ok' });
  await pendingQuizReply(SLACK_USER, CHANNEL)('answer');

  assert.equal(await cancelQuiz(USER), true);
  const events = await store.getReviewEvents(USER);
  assert.deepEqual(events.map((e) => [e.conceptId, e.itemType, e.confidence ?? null]), [
    ['c2', 'free_text', null],
    ['c1', 'mcq', 2],
  ]);
  // Missing confidence counts as Medium, exactly as SM-2 already treats it: floor(0.8 × 5) = 4 → Good.
  assert.equal(events[0].grade, 3);
});

test('T3-5: a failing event write is logged once and the quiz carries on', async () => {
  const { chat } = fakeClient();
  const append = store.appendReviewEvent;
  store.appendReviewEvent = async () => { throw new Error('db down'); };
  try {
    anthropicReplies.push([mcq('c1', 'B'), mcq('c2', 'C')]);
    const quiz = await startQuiz({ chat }, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2 });
    for (const [questionId, letter] of [['q1', 'B'], ['q2', 'C']]) {
      await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId, level: 2 }), client: { chat } });
      await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId, letter, confidenceLevel: 2 }), client: { chat } });
    }
    assert.equal((await store.getHistory(USER, 1))[0].quizId, quiz.quizId, 'quiz completed');
    assert.equal((await store.getQuiz(quiz.quizId)).score, 100);
    const cards = await store.getCards(USER, ['c1', 'c2']);
    assert.ok(cards.every((c) => c?.repetitions === 1), 'SM-2 still applied');
    assert.equal(errors.length, 2, 'one line per failed write, no retries');
    assert.ok(errors.every((e) => e.startsWith('[review-events] append failed') && e.includes('db down')));
  } finally {
    store.appendReviewEvent = append;
  }
});
