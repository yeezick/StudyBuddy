import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubRedis } from './helpers/fakeRedis.js';
import { stubAnthropic } from './helpers/anthropicStub.js';

// Installed before the app modules load; see helpers/anthropicStub.js.
const { replies: anthropicReplies, requests: anthropicRequests } = stubAnthropic();

const { store } = await import('../src/store/index.js');
const { startQuiz, cancelQuiz, pendingQuizReply, onQuizConfidence, onQuizAnswer, onFreeTextConfidence, onQuizEnd } =
  await import('../src/slack/quizFlow.js');
const { claimRetest, isConfidentMiss, retestItemType, localDay, RETEST_DAILY_CAP, RETEST_DELAY_MS } = await import('../src/lib/retest.js');
const { enqueueRetests, handleRetestJob, retestJobId, RETEST_MAX_DEFERS } = await import('../src/slack/retestFlow.js');
const { pendingExplainBack, pickWeakest, onExplainBackSkip, EXPLAIN_BACK_TTL_MS } = await import('../src/slack/explainBack.js');
const { routeMessage } = await import('../src/slack/messageRouter.js');
const { calibrationLine, formatWeeklyDigestBlocks } = await import('../src/slack/masteryFlow.js');

const USER = 'test-user';
const SLACK_USER = 'UOWNER';
const CHANNEL = 'D1';
const CONCEPTS = [
  { id: 'c1', name: 'One', summary: 'one summary' },
  { id: 'c2', name: 'Two', summary: 'two summary' },
  { id: 'c3', name: 'Three', summary: 'three summary' },
];

const mcq = (conceptId, correct) => ({
  conceptId, type: 'mcq', prompt: `About ${conceptId}?`, options: ['A. a', 'B. b', 'C. c', 'D. d'],
  correctAnswer: correct, explanation: 'because',
});
const shortAnswer = (conceptId) => ({ conceptId, type: 'short_answer', prompt: `Explain ${conceptId}`, correctAnswer: 'key points', explanation: 'because' });

function fakeClient() {
  const posted = [];
  const updated = [];
  const chat = {
    postMessage: async (msg) => { posted.push(msg); return { ok: true, ts: String(posted.length) }; },
    update: async (msg) => { updated.push(msg); return { ok: true }; },
    postEphemeral: async (msg) => { posted.push({ ephemeral: true, ...msg }); return { ok: true }; },
  };
  return { client: { chat }, posted, updated };
}

const action = (value) => ({
  ack: async () => {},
  body: { actions: [{ value: JSON.stringify(value) }], channel: { id: CHANNEL }, message: { ts: '1' }, user: { id: SLACK_USER } },
});

async function answerMcq(client, quiz, questionId, level, letter) {
  await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId, level }), client });
  await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId, letter, confidenceLevel: level }), client });
}

async function backdateShown(quizId, index, ms) {
  const quiz = await store.getQuiz(quizId);
  quiz.questions[index].shownAt = new Date(Date.now() - ms).toISOString();
  await store.saveQuiz(quiz);
}

const blockText = (msg) => (msg.blocks ?? []).map((b) => b.text?.text ?? '').join('\n');
const isExplainPrompt = (msg) => /explain-back/i.test(msg.text ?? '') && msg.blocks?.some((b) => b.type === 'actions');

// Every quiz end in this file is captured here instead of going to BullMQ.
const ended = [];
onQuizEnd(async (quiz, { reason }) => { ended.push({ quiz, reason }); });

let fake;
let errors;
let warnings;
const realConsoleError = console.error;
const realConsoleWarn = console.warn;
beforeEach(async () => {
  fake = stubRedis();
  anthropicReplies.length = 0;
  ended.length = 0;
  errors = [];
  warnings = [];
  console.error = (...args) => errors.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  await store.seedConcepts(USER, CONCEPTS);
});
afterEach(() => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
  // A prompt left open by one test must not claim the next test's messages.
  pendingExplainBack(SLACK_USER, CHANNEL, Date.now() + 2 * EXPLAIN_BACK_TTL_MS);
  fake.restore();
});

// ── T5-1 confident-miss retest ────────────────────────────────────────────────

test('T5-1: only a wrong answer with Sure reserves a retest; its feedback says so', async () => {
  const { client, updated } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B'), mcq('c2', 'B'), mcq('c3', 'B')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });

  await answerMcq(client, quiz, 'q1', 3, 'A'); // wrong + Sure
  await answerMcq(client, quiz, 'q2', 2, 'A'); // wrong + Medium
  await answerMcq(client, quiz, 'q3', 3, 'B'); // right + Sure

  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'completed');
  const qs = ended[0].quiz.questions;
  assert.deepEqual(qs.map((q) => q.retestQueued), [true, undefined, undefined]);

  const results = updated.filter((m) => /Correct|Wrong/.test(blockText(m)));
  assert.equal(results.length, 3);
  assert.match(blockText(results[0]), /You were sure — worth a second look; I'll re-check this ~10 min after the quiz/);
  assert.doesNotMatch(blockText(results[1]), /You were sure/);
  assert.doesNotMatch(blockText(results[2]), /You were sure/);

  const jobs = [];
  await enqueueRetests(ended[0].quiz, { addJob: async (...args) => jobs.push(args) });
  assert.deepEqual(jobs, [['retest', {
    userId: USER, slackUserId: SLACK_USER, channelId: CHANNEL, quizId: quiz.quizId, conceptId: 'c1',
    previousPrompt: 'About c1?', defers: 0,
  }, { jobId: retestJobId(quiz.quizId, 'c1'), delay: RETEST_DELAY_MS }]]);
  assert.ok(!jobs[0][2].jobId.includes(':'), 'BullMQ custom ids may not contain ":"');
  assert.deepEqual(errors, []);
});

test('T5-1: a free-text confident miss is flagged on the confidence tap; cancel also queues it', async () => {
  const { client, updated } = fakeClient();
  anthropicReplies.push([shortAnswer('c1'), shortAnswer('c2')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2, distribution: { short_answer: 1 } });

  anthropicReplies.push({ isCorrect: false, score: 0.1, feedback: 'no' });
  await pendingQuizReply(SLACK_USER, CHANNEL)('wrong answer');
  await onFreeTextConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 3 }), client });
  assert.match(blockText(updated.at(-1)), /You were sure/);

  assert.equal(await cancelQuiz(USER), true);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'cancelled');
  const jobs = [];
  await enqueueRetests(ended[0].quiz, { addJob: async (...args) => jobs.push(args) });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0][1].conceptId, 'c1');
});

test('T5-1: retest is idempotent per quiz × concept', async () => {
  const quiz = { userId: 'idem-user', quizId: 'quiz-1' };
  const q = { conceptId: 'c1', isCorrect: false, confidenceRating: 3, prompt: 'p' };
  assert.equal(await claimRetest(quiz, q), true);
  assert.equal(await claimRetest(quiz, q), true, 'the same pair keeps its slot');

  // Two Sure misses on one concept in one quiz → one job.
  const jobs = [];
  await enqueueRetests({
    ...quiz, slackUserId: SLACK_USER, slackChannelId: CHANNEL,
    questions: [{ ...q, id: 'q1', retestQueued: true }, { ...q, id: 'q2', retestQueued: true }],
  }, { addJob: async (...args) => jobs.push(args) });
  assert.equal(jobs.length, 1);
  assert.equal(retestJobId('quiz-1', 'c1'), retestJobId('quiz-1', 'c1'));
});

test(`T5-1: at most ${RETEST_DAILY_CAP} retests per user per day; overflow dropped and logged once`, async () => {
  const q = (conceptId) => ({ conceptId, isCorrect: false, confidenceRating: 3 });
  const results = [];
  for (let i = 1; i <= 5; i++) results.push(await claimRetest({ userId: 'cap-user', quizId: `quiz-${i}` }, q('c1')));
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(warnings.filter((w) => w.includes('[retest] daily cap')).length, 1);
  assert.equal(await claimRetest({ userId: 'other-user', quizId: 'quiz-1' }, q('c1')), true, 'the cap is per user');
});

test('T5-1: the cap-reached feedback line promises no re-check', async () => {
  for (let i = 0; i < RETEST_DAILY_CAP; i++) await store.claimRetest(USER, localDay(), `filler-${i}`, RETEST_DAILY_CAP);
  const { client, updated } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  await answerMcq(client, quiz, 'q1', 3, 'A');
  const text = blockText(updated.find((m) => /Wrong/.test(blockText(m))));
  assert.match(text, /You were sure — worth a second look\./);
  assert.doesNotMatch(text, /re-check/);
  assert.equal(ended[0].quiz.questions[0].retestQueued, false);
});

test('T5-1: the retest job asks one new question; its answer is logged with trigger retest and scheduled', async () => {
  const { client, posted } = fakeClient();
  const data = { userId: USER, slackUserId: SLACK_USER, channelId: CHANNEL, quizId: 'orig-quiz', conceptId: 'c2', previousPrompt: 'Old Q?', defers: 0 };

  anthropicReplies.push([mcq('c2', 'C')]);
  await handleRetestJob(client, data, { addJob: async () => assert.fail('no defer expected') });
  assert.match(posted[0].text, /Quick re-check.*sure about \*Two\*/s);
  const quizId = await store.getActiveQuizId(USER);
  const quiz = await store.getQuiz(quizId);
  assert.equal(quiz.trigger, 'retest');
  assert.equal(quiz.questions.length, 1);
  assert.equal(quiz.questions[0].type, 'mcq', 'a new card gets an MCQ');
  assert.match(quiz.input.freeFormPrompt, /different.*Old Q\?/);

  // Wrong + Sure again: logged and scheduled, but no retest of the retest, and no explain-back.
  await answerMcq(client, quiz, 'q1', 3, 'A');
  const [event] = await store.getReviewEvents(USER);
  assert.equal(event.trigger, 'retest');
  assert.equal(event.conceptId, 'c2');
  assert.equal(event.grade, 1);
  assert.equal(event.nextState.scheduler, 'fsrs', 'FSRS updates as usual');
  assert.equal(ended[0].quiz.questions[0].retestQueued, undefined);
  assert.match(posted.at(-1).text, /Re-check done/);
  assert.ok(!posted.some(isExplainPrompt), 'no explain-back after a retest');
  assert.equal(pendingExplainBack(SLACK_USER, CHANNEL), null);
});

test('T5-1: a retest that finds a quiz in progress waits, then gives up', async () => {
  const { client, posted } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B')]);
  await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  const data = { userId: USER, slackUserId: SLACK_USER, channelId: CHANNEL, quizId: 'orig', conceptId: 'c1', defers: 0 };
  const jobs = [];
  await handleRetestJob(client, data, { addJob: async (...args) => jobs.push(args) });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0][1].defers, 1);
  assert.equal(jobs[0][2].jobId, retestJobId('orig', 'c1', 1));

  await handleRetestJob(client, { ...data, defers: RETEST_MAX_DEFERS }, { addJob: async (...args) => jobs.push(args) });
  assert.equal(jobs.length, 1, 'dropped after the last defer');
  assert.ok(warnings.some((w) => w.includes('[retest] dropped')));
  assert.equal(posted.length, 1, 'only the in-progress quiz question was posted');
});

test('T5-1: question type follows the card state', () => {
  assert.equal(retestItemType(null), 'mcq');
  const card = (state) => ({ conceptId: 'c1', scheduler: 'fsrs', stability: 1, difficulty: 5, state, reps: 1, lapses: 0, due: '2026-10-03T00:00:00.000Z', last_review: '2026-10-02T00:00:00.000Z', elapsed_days: 0, scheduled_days: 0, learning_steps: 0 });
  assert.equal(retestItemType(card(0)), 'mcq', 'New');
  assert.equal(retestItemType(card(1)), 'mcq', 'Learning');
  assert.equal(retestItemType(card(2)), 'short_answer', 'Review');
  assert.equal(retestItemType(card(3)), 'short_answer', 'Relearning');
  assert.equal(isConfidentMiss({ isCorrect: false, confidenceRating: 3 }), true);
  assert.equal(isConfidentMiss({ isCorrect: null, confidenceRating: 3 }), false);
});

// ── T5-2 explain-back ─────────────────────────────────────────────────────────

test('T5-2: weakest = lowest grade; tie → longest latency, idle ignored; then first asked', () => {
  const at = (ms) => ({ shownAt: '2026-10-03T10:00:00.000Z', answeredAt: new Date(Date.parse('2026-10-03T10:00:00.000Z') + ms).toISOString() });
  const q = (id, isCorrect, confidenceRating, ms) => ({ id, conceptId: id, isCorrect, confidenceRating, ...at(ms) });
  assert.equal(pickWeakest([q('a', true, 3, 1000), q('b', true, 1, 1000), q('c', true, 2, 9000)]).id, 'b', 'Hard < Good < Easy');
  assert.equal(pickWeakest([q('a', false, 1, 1000), q('b', false, 3, 4000)]).id, 'b', 'tie on Again → slower');
  assert.equal(pickWeakest([q('a', false, 1, 4000), q('b', false, 3, 10 * 60 * 1000)]).id, 'a', 'idle latency counts as none');
  assert.equal(pickWeakest([q('a', true, 2, 2000), q('b', true, 2, 2000)]).id, 'a', 'full tie → first asked');
  assert.equal(pickWeakest([{ id: 'x', isCorrect: null }]), null, 'nothing answered');
});

test('T5-2: a completed quiz posts one explain-back on the weakest concept; the reply is graded and logged unscheduled', async () => {
  const { client, posted } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B'), mcq('c2', 'B'), mcq('c3', 'B')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  await answerMcq(client, quiz, 'q1', 3, 'B'); // Easy
  await backdateShown(quiz.quizId, 1, 3000);
  await answerMcq(client, quiz, 'q2', 1, 'A'); // Again, 3 s
  await backdateShown(quiz.quizId, 2, 8000);
  await answerMcq(client, quiz, 'q3', 2, 'A'); // Again, 8 s → weakest

  const prompts = posted.filter(isExplainPrompt);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /In 1–2 sentences, why does \*Three\*/);
  assert.ok(posted.indexOf(prompts[0]) > posted.findIndex((m) => /Quiz complete/.test(m.text ?? '')), 'after the summary');

  const [cardBefore] = await store.getCards(USER, ['c3']);
  const reply = pendingExplainBack(SLACK_USER, CHANNEL);
  assert.ok(reply);
  // The router hands it the message, even one that looks like a break request.
  assert.equal(routeMessage({ user: SLACK_USER, channel: CHANNEL, text: 'it lets you pause for 10 min' }, {
    hasQuizReply: () => Boolean(pendingQuizReply(SLACK_USER, CHANNEL)),
    hasExplainReply: () => Boolean(pendingExplainBack(SLACK_USER, CHANNEL)),
    hasSessionReply: () => true,
  }), 'explain');

  anthropicReplies.push({ isCorrect: true, score: 0.8, feedback: 'solid' });
  await reply('it lets you pause for 10 min', client);
  assert.match(posted.at(-1).text, /Explain-back: 80\/100/);
  assert.equal(pendingExplainBack(SLACK_USER, CHANNEL), null, 'consumed');

  const [event] = await store.getReviewEvents(USER);
  assert.equal(event.itemType, 'explain_back');
  assert.equal(event.conceptId, 'c3');
  assert.equal(event.quizId, quiz.quizId);
  assert.equal(event.correct, true);
  assert.equal(event.score, 0.8);
  assert.equal(event.grade, null);
  assert.equal(event.confidence, null);
  assert.equal(event.prevState, null);
  assert.deepEqual(
    { ...event.nextState, prompt: undefined },
    { scheduled: false, prompt: undefined, explanation: 'it lets you pause for 10 min', feedback: 'solid', idle_latency: false },
  );
  const [cardAfter] = await store.getCards(USER, ['c3']);
  assert.deepEqual(cardAfter, cardBefore, 'explain-back never reschedules');
  assert.equal((await store.getReviewEvents(USER)).length, 4, '3 answers + 1 explain-back');
  assert.deepEqual(errors, []);
});

test('T5-2: no explain-back on cancel', async () => {
  const { client, posted } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B'), mcq('c2', 'B')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2 });
  await answerMcq(client, quiz, 'q1', 1, 'A');
  await cancelQuiz(USER);
  assert.ok(!posted.some(isExplainPrompt));
  assert.equal(pendingExplainBack(SLACK_USER, CHANNEL), null);
});

test('T5-2: Skip closes the prompt; the next message goes to break detection', async () => {
  const { client, updated } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  assert.ok(pendingExplainBack(SLACK_USER, CHANNEL));

  await onExplainBackSkip({ ...action({ quizId: quiz.quizId, conceptId: 'c1' }), client });
  assert.match(updated.at(-1).text, /skipped/);
  assert.equal(pendingExplainBack(SLACK_USER, CHANNEL), null);
  assert.equal(routeMessage({ user: SLACK_USER, channel: CHANNEL, text: 'brb 10 min break' }, {
    hasQuizReply: () => false,
    hasExplainReply: () => Boolean(pendingExplainBack(SLACK_USER, CHANNEL)),
    hasSessionReply: () => false,
  }), 'break');
  assert.equal((await store.getReviewEvents(USER)).length, 2, 'the answer + the skip (T5b-4)');
});

test('T5-2: an unanswered prompt expires; a new quiz takes the channel back', async () => {
  const { client } = fakeClient();
  anthropicReplies.push([mcq('c1', 'B')]);
  let quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  assert.ok(pendingExplainBack(SLACK_USER, CHANNEL, Date.now() + EXPLAIN_BACK_TTL_MS - 1000));
  assert.equal(pendingExplainBack(SLACK_USER, CHANNEL, Date.now() + EXPLAIN_BACK_TTL_MS + 1000), null);

  anthropicReplies.push([mcq('c1', 'B')]);
  quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  assert.ok(pendingExplainBack(SLACK_USER, CHANNEL));
  anthropicReplies.push([mcq('c2', 'B')]);
  await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  assert.equal(pendingExplainBack(SLACK_USER, CHANNEL), null);
});

// ── T5-3 calibration line ─────────────────────────────────────────────────────

test('T5-3: calibration per confidence level; explain-backs and untapped answers left out', () => {
  const e = (confidence, correct, itemType = 'mcq') => ({ confidence, correct, itemType });
  const events = [
    e(1, true), e(1, false), e(1, false), e(1, false),        // Guess 1/4 = 25%
    e(2, true), e(2, true), e(2, false),                      // Medium 2/3 = 67%
    e(3, true), e(3, true), e(3, true), e(3, false),          // Sure 3/4 = 75%
    e(null, true), e(undefined, false),                       // no tap
    e(null, false, 'explain_back'), e(3, false, 'explain_back'),
  ];
  assert.equal(calibrationLine(events), 'Calibration (7 days): Guess 25% right (4) · Medium 67% (3) · Sure 75% (4)');
});

test('T5-3: a level with n = 0 is omitted; the line is omitted when n < 5', () => {
  const e = (confidence, correct) => ({ confidence, correct, itemType: 'free_text' });
  assert.equal(calibrationLine([e(2, true), e(2, false), e(3, true), e(3, true), e(3, true)]),
    'Calibration (7 days): Medium 50% right (2) · Sure 100% (3)');
  assert.equal(calibrationLine([e(1, true), e(2, true), e(3, true), e(3, false)]), null);
  assert.equal(calibrationLine([]), null);

  const snapshot = { modules: [{ name: 'M1', avg: 0.5, count: 2 }], dueToday: [] };
  const withLine = formatWeeklyDigestBlocks(snapshot, null, { quizCount: 1, conceptsTested: 2, calibration: 'Calibration (7 days): Sure 100% right (5)' });
  assert.ok(withLine.some((b) => b.text.text === 'Calibration (7 days): Sure 100% right (5)'));
  const without = formatWeeklyDigestBlocks(snapshot, null, { quizCount: 1, conceptsTested: 2, calibration: null });
  assert.equal(without.length, withLine.length - 1);
});
