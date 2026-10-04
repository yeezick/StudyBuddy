import './helpers/env.js';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stubRedis } from './helpers/fakeRedis.js';
import { stubAnthropic, sseResponse } from './helpers/anthropicStub.js';

// Installed before the app modules load; see helpers/anthropicStub.js.
const { replies: anthropicReplies, requests: anthropicRequests } = stubAnthropic();

const { store } = await import('../src/store/index.js');
const { startQuiz, pendingQuizReply, onQuizConfidence, onQuizAnswer, onFreeTextConfidence, onQuizEnd } =
  await import('../src/slack/quizFlow.js');
const { appendInterleaved, leadType, visiblePart } = await import('../src/ai/questionGen.js');
const { pendingExplainBack, onExplainBackSkip, tailoredExplainBackPrompt, explainBackPrompt, EXPLAIN_BACK_TTL_MS } =
  await import('../src/slack/explainBack.js');
const { calibrationLine } = await import('../src/slack/masteryFlow.js');
const { buildBriefSnapshot } = await import('../src/slack/briefFlow.js');
const { weekStats } = await import('../src/scheduler/jobs.js');
const { createMcpServer } = await import('../src/mcp/server.js');

const USER = 'test-user';
const SLACK_USER = 'UOWNER';
const CHANNEL = 'D1';
const CONCEPTS = [
  { id: 'c1', name: 'One', summary: 'one summary' },
  { id: 'c2', name: 'Two', summary: 'two summary' },
  { id: 'c3', name: 'Three', summary: 'three summary' },
];

const mcq = (conceptId, correct = 'B') => ({
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

// The concept ids a question-generation request offers, and a reply with one MCQ per question
// asked, on those concepts in order.
const conceptsIn = (body) => JSON.parse(/\nConcepts:\n(.*)\n/.exec(body.messages[0].content)[1]).map((c) => c.id);
const echoMcqs = (body) => {
  const n = Number(/^Generate (\d+) questions/.exec(body.messages[0].content)[1]);
  const ids = conceptsIn(body);
  return Array.from({ length: n }, (_, i) => mcq(ids[i % ids.length]));
};

// A reply the test releases by hand, to hold a call open. Released in afterEach at the latest:
// an open request keeps the SDK's timeout timer, and the test process, alive.
const held = [];
function heldReply(answer) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  held.push(release);
  return { reply: async (body) => { await gate; return answer(body); }, release };
}

// A streamed one-MCQ reply on the requested concept, cut just after "correctAnswer" (where the
// question becomes visible). `hold` keeps the rest back until release(); `tail` replaces it.
function streamedMcq({ hold = false, tail = null } = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  held.push(release);
  const reply = (body) => {
    assert.equal(body.stream, true);
    const text = JSON.stringify([mcq(conceptsIn(body)[0])]);
    const cut = text.indexOf('"correctAnswer"') + '"correctAnswer"'.length;
    const rest = tail ?? text.slice(cut);
    return sseResponse([text.slice(0, cut), hold ? gate.then(() => rest) : rest]);
  };
  return { reply, release };
}

const blockText = (msg) => (msg.blocks ?? []).map((b) => b.text?.text ?? '').join('\n');
const buttonLabels = (msg) => msg.blocks.find((b) => b.type === 'actions').elements.map((e) => e.text.text);
const isExplainPrompt = (msg) => /explain-back/i.test(msg.text ?? '') && msg.blocks?.some((b) => b.type === 'actions');
const flush = () => new Promise((resolve) => setImmediate(resolve));

const ended = [];
onQuizEnd(async (quiz, { reason }) => { ended.push({ quiz, reason }); });

let fake;
let errors;
let warnings;
let logs;
const real = { error: console.error, warn: console.warn, log: console.log };
beforeEach(async () => {
  fake = stubRedis();
  anthropicReplies.length = 0;
  anthropicRequests.length = 0;
  ended.length = 0;
  errors = [];
  warnings = [];
  logs = [];
  console.error = (...args) => errors.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  await store.seedConcepts(USER, CONCEPTS);
});
afterEach(() => {
  for (const release of held.splice(0)) release();
  Object.assign(console, real);
  pendingExplainBack(SLACK_USER, CHANNEL, Date.now() + 2 * EXPLAIN_BACK_TTL_MS);
  fake.restore();
});

// ── T5b-1 faster first question ───────────────────────────────────────────────

test('T5b-1: Q1, Q2 and the rest are written at once on separate concepts; Q1 posts first; quiz_ready_ms is logged', async () => {
  const { client, posted } = fakeClient();
  const q2 = heldReply(echoMcqs);
  anthropicReplies.push(echoMcqs, q2.reply, echoMcqs);

  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3, requestedAt: Date.now() - 1234 });
  await flush();
  assert.equal(anthropicRequests.length, 3, 'all three calls start before Q1 is answered');
  const [r1, r2, r3] = anthropicRequests.map((r) => r.messages[0].content);
  const [lead1, lead2, others] = anthropicRequests.map(conceptsIn);
  assert.equal(lead1.length, 1);
  assert.equal(lead2.length, 1);
  assert.deepEqual([...lead1, ...lead2, ...others].sort(), ['c1', 'c2', 'c3'], 'each concept offered to exactly one call');
  assert.match(r1, /^Generate 1 questions\.\nType distribution: 100% mcq/);
  assert.match(r2, /^Generate 1 questions\.\nType distribution: 100% (mcq|short_answer|explain)\n/, 'Q2 type drawn from the mix (DEC-060 §2)');
  assert.match(r3, /^Generate 1 questions\.\nType distribution: 60% mcq, 20% short_answer, 20% explain/);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, `Q1/3: About ${lead1[0]}?`);
  assert.equal(quiz.questions.length, 1);
  assert.equal(quiz.total, 3);
  const ready = logs.find((l) => l.includes('[quiz] ready'));
  assert.match(ready, new RegExp(`quizId=${quiz.quizId} \\| trigger=on_demand \\| quiz_ready_ms=\\d+`));
  assert.ok(Number(/quiz_ready_ms=(\d+)/.exec(ready)[1]) >= 1234, 'measured from the command, not from startQuiz');

  // Q1 answered while Q2 is still being written: the user is told, then Q2 follows.
  const answering = answerMcq(client, quiz, 'q1', 2, 'B');
  await flush();
  await flush();
  assert.ok(posted.some((m) => /Writing the next question/.test(m.text ?? '')));
  q2.release();
  await answering;
  assert.equal(posted.at(-1).text, `Q2/3: About ${lead2[0]}?`);

  await answerMcq(client, quiz, 'q2', 2, 'B');
  assert.equal(posted.at(-1).text, `Q3/3: About ${others[0]}?`, 'already written, no wait');
  assert.equal(posted.filter((m) => /Writing the next question/.test(m.text ?? '')).length, 1);
  await answerMcq(client, quiz, 'q3', 2, 'A');

  const done = ended[0].quiz;
  assert.deepEqual(done.questions.map((q) => `${q.id}:${q.conceptId}`), [`q1:${lead1[0]}`, `q2:${lead2[0]}`, `q3:${others[0]}`]);
  assert.ok(posted.some((m) => /Quiz complete — 67\/100 {2}\(2\/3 correct\)/.test(m.text ?? '')));
  assert.deepEqual(errors, []);
});

test('T5b-1: too few concepts to keep apart → Q1 first, then the rest told what it asked, Q1 concept not first', async () => {
  const { client, posted } = fakeClient();
  const two = CONCEPTS.slice(0, 2);
  anthropicReplies.push([mcq('c1')], [mcq('c1'), mcq('c2')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: two, count: 3 });
  await flush();
  assert.equal(anthropicRequests.length, 2);
  assert.deepEqual(conceptsIn(anthropicRequests[0]), ['c1', 'c2']);
  assert.match(anthropicRequests[1].messages[0].content, /^Generate 2 questions/);
  assert.match(anthropicRequests[1].messages[0].content, /Already asked in this quiz.*must not use conceptId "c1"\):\n- \[c1\] About c1\?/s);

  await answerMcq(client, quiz, 'q1', 2, 'B');
  const stored = await store.getQuiz(quiz.quizId);
  assert.deepEqual(stored.questions.map((q) => q.conceptId), ['c1', 'c2', 'c1'], 'reordered: never two in a row');
  assert.equal(posted.at(-1).text, 'Q2/3: About c2?');
});

test('T5b-1: rest ready before Q1 is answered → no wait message; a free-text Q1 works the same', async () => {
  const { client, posted } = fakeClient();
  anthropicReplies.push([shortAnswer('c1'), mcq('c2')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2, distribution: { short_answer: 0.5, mcq: 0.5 } });
  await flush();
  assert.match(posted[0].text, /^\*Q1\/2:\* Explain c1/);

  anthropicReplies.push({ isCorrect: true, score: 0.9, feedback: 'good' });
  await pendingQuizReply(SLACK_USER, CHANNEL)('my answer');
  await onFreeTextConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 2 }), client });
  assert.ok(!posted.some((m) => /Writing the next question/.test(m.text ?? '')));
  assert.equal(posted.at(-1).text, 'Q2/2: About c2?');
});

test('T5b-1: a failed batch is skipped; when all fail the quiz ends with the questions answered', async () => {
  let { client, posted } = fakeClient();
  anthropicReplies.push(echoMcqs, new Error('boom'), echoMcqs);
  let quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  assert.match(posted.at(-1).text, /^Q2\/2: /, 'Q2 failed: the rest move up, the total drops');
  assert.ok(!posted.some((m) => /Couldn't write/.test(m.text ?? '')));
  assert.ok(errors.some((e) => e.includes('[quiz] background questions failed')));
  await answerMcq(client, quiz, 'q2', 2, 'B');
  assert.ok(posted.some((m) => /Quiz complete — 100\/100 {2}\(2\/2 correct\)/.test(m.text ?? '')));

  ({ client, posted } = fakeClient());
  ended.length = 0;
  anthropicReplies.push(echoMcqs, new Error('boom'), new Error('boom'));
  quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  assert.ok(posted.some((m) => /Couldn't write the rest of this quiz/.test(m.text ?? '')));
  assert.equal(ended[0].reason, 'completed');
  assert.ok(posted.some((m) => /Quiz complete — 100\/100 {2}\(1\/1 correct\)/.test(m.text ?? '')));
});

test('T5b-1: Q1 is posted while its answer key is still streaming; an early answer waits for it', async () => {
  const { client, posted, updated } = fakeClient();
  const q1 = streamedMcq({ hold: true });
  anthropicReplies.push(q1.reply, echoMcqs, echoMcqs);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  assert.equal(anthropicRequests[0].stream, true, 'Q1 is streamed');
  assert.equal(anthropicRequests[1].stream, undefined, 'the others are not');
  const lead = conceptsIn(anthropicRequests[0])[0];
  assert.equal(posted[0].text, `Q1/3: About ${lead}?`);
  assert.equal((await store.getQuiz(quiz.quizId)).questions[0].correctAnswer, undefined, 'no answer key yet');

  await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 2 }), client });
  const answering = onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId: 'q1', letter: 'B', confidenceLevel: 2 }), client });
  await flush();
  assert.ok(!updated.some((m) => /Correct|Wrong/.test(blockText(m))), 'not graded before the key arrives');
  // An impatient second tap on another letter is ignored.
  await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId: 'q1', letter: 'A', confidenceLevel: 2 }), client });
  q1.release();
  await answering;
  assert.equal((await store.getReviewEvents(USER)).length, 1, 'graded once');
  assert.match(blockText(updated.at(-1)), /✅ Correct/);
  assert.match(blockText(updated.at(-1)), /_because_/, 'the streamed explanation is the feedback');
  const stored = await store.getQuiz(quiz.quizId);
  assert.equal(stored.questions[0].correctAnswer, 'B');
  assert.equal(stored.questions[0].explanation, 'because');
  assert.match(posted.at(-1).text, /^Q2\/3: /);
  assert.deepEqual(errors, []);
});

test('T5b-1: a stream that breaks after Q1 was shown gets its answer key from a second call', async () => {
  const { client, updated } = fakeClient();
  anthropicReplies.push(streamedMcq({ tail: ': "B", oops' }).reply, echoMcqs, echoMcqs);
  anthropicReplies.push({ correctAnswer: 'C. c', explanation: 'rewritten key' });
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  await answerMcq(client, quiz, 'q1', 2, 'C');
  assert.match(blockText(updated.at(-1)), /✅ Correct/);
  assert.match(blockText(updated.at(-1)), /rewritten key/);
  const keyCall = anthropicRequests.at(-1);
  assert.match(keyCall.system.map((b) => b.text).join('\n'), /Write the answer key/);
  assert.match(keyCall.messages[0].content, /Question \(mcq\): About c\d\?\nOptions:\nA\. a\nB\. b/);
  assert.ok(warnings.some((w) => w.includes('[questionGen] streamed question failed, recovering | shown=true')));
});

test('T5b-1: a stream that fails before Q1 is shown is retried once without streaming; a second failure stops the quiz', async () => {
  let { client, posted } = fakeClient();
  anthropicReplies.push(new Error('stream down'), echoMcqs, echoMcqs, echoMcqs);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  assert.equal(anthropicRequests[3].stream, undefined);
  assert.deepEqual(conceptsIn(anthropicRequests[3]), conceptsIn(anthropicRequests[0]), 'same concept as the failed stream');
  assert.match(posted[0].text, /^Q1\/3: /);
  assert.equal(quiz.questions[0].correctAnswer, 'B', 'the retry brings the whole question');

  ({ client, posted } = fakeClient());
  anthropicRequests.length = 0;
  await store.clearActiveQuizId(USER);
  anthropicReplies.push(new Error('boom'), echoMcqs, echoMcqs, new Error('boom again'));
  await assert.rejects(startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 }), /boom again/);
  assert.equal(posted.length, 0);
  assert.equal(await store.getActiveQuizId(USER), null);
});

test('T5b-1: visiblePart reads prompt and options once the model reaches correctAnswer', () => {
  const text = JSON.stringify([mcq('c1')]);
  const at = (s) => text.slice(0, text.indexOf(s) + s.length);
  assert.equal(visiblePart(at('"options"')), null, 'options not written yet');
  assert.deepEqual(visiblePart(at('"correctAnswer"')), { conceptId: 'c1', type: 'mcq', prompt: 'About c1?', options: ['A. a', 'B. b', 'C. c', 'D. d'] });
  assert.deepEqual(visiblePart('```json\n' + at('"correctAnswer"')).prompt, 'About c1?', 'fenced');
  const free = JSON.stringify([shortAnswer('c2')]);
  assert.equal(visiblePart(free.slice(0, free.indexOf('"correctAnswer"') + '"correctAnswer"'.length)).type, 'short_answer', 'no options needed');
  assert.equal(visiblePart('[{"conceptId":"c1","type":"mcq","prompt":"P?","options":[],"correctAnswer"'), null, 'an MCQ needs options');
  assert.equal(visiblePart('[{"prompt": broken, "correctAnswer"'), null);
});

test('T5b-1: a one-question quiz (retest) makes one call and no background call', async () => {
  const { client } = fakeClient();
  anthropicReplies.push([shortAnswer('c2')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, { mode: 'retest' }, {
    trigger: 'retest', concepts: [CONCEPTS[1]], count: 1, distribution: { short_answer: 1 },
  });
  await flush();
  assert.equal(anthropicRequests.length, 1);
  assert.match(anthropicRequests[0].messages[0].content, /100% short_answer/);
  assert.equal(quiz.total, 1);
});

test('T5b-1: interleaving helpers', () => {
  const q = (conceptId) => ({ conceptId });
  const ids = (qs) => qs.map((x) => x.conceptId).join('');
  assert.equal(ids(appendInterleaved([q('a')], [q('a'), q('b'), q('c')])), 'abac');
  assert.equal(ids(appendInterleaved([q('a')], [q('b'), q('a')])), 'aba', 'already fine → unchanged');
  assert.equal(ids(appendInterleaved([q('a')], [q('a')])), 'aa', 'no way around it → kept');
  assert.equal(leadType({ mcq: 0.6, short_answer: 0.2, explain: 0.2 }), 'mcq');
  assert.equal(leadType({ short_answer: 1 }), 'short_answer');
});

// ── T5b-2 Guess / Medium / Sure ───────────────────────────────────────────────

test('T5b-2: confidence buttons read Guess/Medium/Sure; stored values and action ids unchanged', async () => {
  const { client, posted, updated } = fakeClient();
  anthropicReplies.push([mcq('c1'), shortAnswer('c2')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2 });
  const conf = posted[0].blocks.find((b) => b.type === 'actions');
  assert.deepEqual(buttonLabels(posted[0]), ['Guess', 'Medium', 'Sure']);
  assert.deepEqual(conf.elements.map((e) => e.action_id), ['quiz_confidence_1', 'quiz_confidence_2', 'quiz_confidence_3']);
  assert.deepEqual(conf.elements.map((e) => JSON.parse(e.value).level), [1, 2, 3]);

  await onQuizConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q1', level: 3 }), client });
  assert.match(blockText(updated.at(-1)), /Confidence: Sure ✓/);
  await onQuizAnswer({ ...action({ quizId: quiz.quizId, questionId: 'q1', letter: 'B', confidenceLevel: 3 }), client });
  assert.match(blockText(updated.at(-1)), /Confidence: Sure {2}· {2}✅ Correct/);

  anthropicReplies.push({ isCorrect: true, score: 1, feedback: 'ok' });
  await pendingQuizReply(SLACK_USER, CHANNEL)('answer');
  const ft = posted.at(-1);
  assert.deepEqual(buttonLabels(ft), ['Guess', 'Medium', 'Sure']);
  assert.deepEqual(ft.blocks.find((b) => b.type === 'actions').elements.map((e) => e.action_id),
    ['quiz_freetext_confidence_1', 'quiz_freetext_confidence_2', 'quiz_freetext_confidence_3']);
  await onFreeTextConfidence({ ...action({ quizId: quiz.quizId, questionId: 'q2', level: 1 }), client });
  assert.match(blockText(updated.at(-1)), /Confidence: Guess {2}· {2}✅ Correct/);

  const events = await store.getReviewEvents(USER);
  assert.deepEqual(events.filter((e) => e.itemType !== 'explain_back').map((e) => e.confidence), [1, 3], 'stored 1/2/3 as before');
});

// ── T5b-3 tailored explain-back question ──────────────────────────────────────

const TAILORED = 'In 1–2 sentences, why does *Three* fail when the context is stale?';

test('T5b-3: the explain-back asks an AI-written question from the summary and the missed question', async () => {
  const { client, posted } = fakeClient();
  anthropicReplies.push([mcq('c1'), mcq('c3')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 2 });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  anthropicReplies.push({ question: TAILORED });
  await answerMcq(client, quiz, 'q2', 3, 'A'); // wrong → weakest, its question goes in

  const prompt = posted.find(isExplainPrompt);
  assert.match(blockText(prompt), new RegExp(TAILORED.replace(/[*?]/g, '\\$&')));
  const req = anthropicRequests.at(-1);
  assert.match(req.messages[0].content, /Concept: Three\nSummary: three summary\nThe learner just got this quiz question on it wrong: "About c3\?"/);
  assert.equal(req.max_tokens, 200);

  anthropicReplies.push({ isCorrect: true, score: 0.9, feedback: 'nice' });
  await pendingExplainBack(SLACK_USER, CHANNEL)('because stale', client);
  const [event] = await store.getReviewEvents(USER);
  assert.equal(event.itemType, 'explain_back');
  assert.equal(event.nextState.prompt, TAILORED);
  assert.deepEqual(warnings, []);
});

test('T5b-3: no missed question → the call gets the summary only', async () => {
  anthropicReplies.push({ question: 'In 1-2 sentences, why does it help?' });
  const q = await tailoredExplainBackPrompt({ name: 'One', summary: 'one summary' });
  assert.equal(q, 'In 1-2 sentences, why does it help?');
  assert.doesNotMatch(anthropicRequests[0].messages[0].content, /got this quiz question/);
});

test('T5b-3: an error, an odd reply or a timeout falls back to the fixed template', async () => {
  const fallback = explainBackPrompt('One');

  anthropicReplies.push(new Error('overloaded'));
  assert.equal(await tailoredExplainBackPrompt({ name: 'One', summary: 's' }), fallback);

  anthropicReplies.push({ question: 'What is One?' });
  assert.equal(await tailoredExplainBackPrompt({ name: 'One', summary: 's' }), fallback);

  anthropicReplies.push({ nope: true });
  assert.equal(await tailoredExplainBackPrompt({ name: 'One', summary: 's' }), fallback);

  // A call that never answers is abandoned at the timeout.
  anthropicReplies.push((_body, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  assert.equal(await tailoredExplainBackPrompt({ name: 'One', summary: 's' }, { timeoutMs: 50 }), fallback);
  assert.ok(Date.now() - started < 2000, 'no retries after the timeout');

  assert.equal(warnings.filter((w) => w.includes('[explain-back] tailored question failed')).length, 4);
  assert.equal(anthropicRequests.length, 4, 'one call each, no retries');
});

test('T5b-3: when the AI call fails at quiz end the template prompt is still posted', async () => {
  const { client, posted } = fakeClient();
  anthropicReplies.push([mcq('c1')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  await answerMcq(client, quiz, 'q1', 2, 'A'); // nothing queued for the explain-back call → error
  assert.match(blockText(posted.find(isExplainPrompt)), /In 1–2 sentences, why does \*One\* matter/);
});

// ── T5b-4 Skip is logged ──────────────────────────────────────────────────────

async function quizWithExplainBack(client) {
  anthropicReplies.push([mcq('c1')]);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 1 });
  anthropicReplies.push({ question: 'In 1–2 sentences, why does *One* work?' });
  await answerMcq(client, quiz, 'q1', 2, 'B');
  return quiz;
}

test('T5b-4: Skip logs an explain_back event marked skipped; nothing is rescheduled', async () => {
  const { client } = fakeClient();
  const quiz = await quizWithExplainBack(client);
  const [cardBefore] = await store.getCards(USER, ['c1']);

  await onExplainBackSkip({ ...action({ quizId: quiz.quizId, conceptId: 'c1' }), client });
  const [skip, answer] = await store.getReviewEvents(USER);
  assert.equal(answer.itemType, 'mcq');
  assert.deepEqual(
    { ...skip, ts: undefined, latencyMs: undefined, topicId: undefined },
    {
      userId: USER, conceptId: 'c1', ts: undefined, topicId: undefined, trigger: 'on_demand', quizId: quiz.quizId,
      itemType: 'explain_back', correct: null, score: null, confidence: null, latencyMs: undefined, grade: null, prevState: null,
      nextState: { scheduled: false, skipped: true, prompt: 'In 1–2 sentences, why does *One* work?' },
    },
  );
  assert.equal(typeof skip.latencyMs, 'number');
  const [cardAfter] = await store.getCards(USER, ['c1']);
  assert.deepEqual(cardAfter, cardBefore, 'a skip never reschedules');

  // A second tap on the same Skip logs nothing more.
  await onExplainBackSkip({ ...action({ quizId: quiz.quizId, conceptId: 'c1' }), client });
  assert.equal((await store.getReviewEvents(USER)).length, 2);
  assert.deepEqual(errors, []);
});

test('T5b-4: the 30-min lapse logs nothing, and neither does a Skip after it', async () => {
  const { client } = fakeClient();
  const quiz = await quizWithExplainBack(client);
  mock.timers.enable({ apis: ['Date'], now: Date.now() + EXPLAIN_BACK_TTL_MS + 60_000 });
  try {
    await onExplainBackSkip({ ...action({ quizId: quiz.quizId, conceptId: 'c1' }), client });
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual((await store.getReviewEvents(USER)).map((e) => e.itemType), ['mcq']);
});

test('T5b-4: calibration ignores skipped explain-backs', () => {
  const e = (confidence, correct) => ({ confidence, correct, itemType: 'mcq' });
  const skip = { itemType: 'explain_back', correct: null, score: null, confidence: null, grade: null, nextState: { scheduled: false, skipped: true } };
  const answers = [e(3, true), e(3, true), e(3, true), e(3, false), e(2, true)];
  assert.equal(calibrationLine([...answers, skip, skip]), calibrationLine(answers));
  assert.equal(calibrationLine([e(3, true), e(3, true), e(3, true), e(3, true), skip]), null, 'a skip is not counted toward n');
});

// ── T5b-5 retests out of the quiz counts ──────────────────────────────────────

const historyEntry = (quizId, trigger, conceptIds, completedAt = new Date().toISOString()) =>
  ({ quizId, trigger, scope: null, score: 50, conceptIds, completedAt });

test('T5b-5: the weekly quiz count leaves retests out; their review events still count for calibration', async () => {
  await store.addHistory(USER, historyEntry('q1', 'on_demand', ['c1', 'c2']));
  await store.addHistory(USER, historyEntry('r1', 'retest', ['c3']));
  for (let i = 0; i < 4; i++) {
    await store.appendReviewEvent({ userId: USER, conceptId: 'c1', trigger: 'on_demand', itemType: 'mcq', correct: true, confidence: 3, grade: 4 });
  }
  await store.appendReviewEvent({ userId: USER, conceptId: 'c3', trigger: 'retest', itemType: 'mcq', correct: false, confidence: 3, grade: 1 });

  const stats = await weekStats(USER);
  assert.equal(stats.quizCount, 1);
  assert.equal(stats.conceptsTested, 2, 'the retest concept is not counted from history');
  assert.equal(stats.calibration, 'Calibration (7 days): Sure 80% right (5)', 'the retest answer is in calibration');
});

test('T5b-5: /brief "last quiz" skips a retest', async () => {
  await store.addHistory(USER, historyEntry('q1', 'on_demand', ['c1']));
  await store.addHistory(USER, historyEntry('r1', 'retest', ['c1']));
  assert.equal((await buildBriefSnapshot(USER)).lastQuiz.quizId, 'q1');
});

test('T5b-5: MCP get_history leaves retests out unless includeRetests', async () => {
  await store.addHistory(USER, historyEntry('q1', 'on_demand', ['c1']));
  await store.addHistory(USER, historyEntry('r1', 'retest', ['c1']));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientSide);
  try {
    const ids = async (args) => JSON.parse((await mcp.callTool({ name: 'get_history', arguments: { userId: USER, ...args } })).content[0].text).map((e) => e.quizId);
    assert.deepEqual(await ids({}), ['q1']);
    assert.deepEqual(await ids({ includeRetests: true }), ['r1', 'q1']);
  } finally {
    await mcp.close();
  }
});
