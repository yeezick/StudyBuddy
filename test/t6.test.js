import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { stubRedis } from './helpers/fakeRedis.js';
import { stubAnthropic } from './helpers/anthropicStub.js';

// Installed before the app modules load; see helpers/anthropicStub.js.
const { replies: anthropicReplies, requests: anthropicRequests } = stubAnthropic();

const { store } = await import('../src/store/index.js');
const { startQuiz, pickLeads, sampleType, pendingQuizReply, onQuizConfidence, onQuizAnswer } = await import('../src/slack/quizFlow.js');
const { generateQuestions } = await import('../src/ai/questionGen.js');
const { gradeFreeText } = await import('../src/ai/grading.js');
const { tailoredExplainBackPrompt } = await import('../src/slack/explainBack.js');
const { callJSON } = await import('../src/ai/anthropic.js');
const { professorPrefix, professorSystem } = await import('../src/ai/professor.js');
const { TEMPLATES } = await import('../src/lib/templates.js');
const { normalizeSpec, getTopicSpec, AI_PM_SPEC } = await import('../src/lib/topicSpec.js');
const { reviewCard, isDue } = await import('../src/lib/mastery.js');
const { scheduler, schedulerFor } = await import('../src/lib/fsrs.js');
const { createMcpServer } = await import('../src/mcp/server.js');

const USER = 'test-user';
const SLACK_USER = 'UOWNER';
const CHANNEL = 'D1';
const CONCEPTS = [
  { id: 'c1', name: 'One', summary: 'one summary' },
  { id: 'c2', name: 'Two', summary: 'two summary' },
  { id: 'c3', name: 'Three', summary: 'three summary' },
];

// Today's task prompts (main@c2b196e), which the ai-pm professor must keep word for word.
const TODAY = {
  question: 'You are an expert assessment designer trained in retrieval practice and elaborative interrogation. Generate questions that test deep understanding, not surface recall. Apply interleaving — never place consecutive questions on the same concept. Return ONLY a JSON array. No preamble, no markdown fences.',
  grader: 'You are a strict but fair grader. Be generous with partial credit when the student demonstrates understanding despite imprecise phrasing. Return ONLY JSON. No preamble.',
  explainBack: 'You write one short explain-back question for a learner who just finished a quiz. It asks them to explain in their own words why something about the concept is true or matters, and it must be answerable from the concept summary. Return ONLY JSON: {"question": "..."}. No preamble, no markdown fences.',
  questionRules: `Rules:
- MCQ distractors must be plausible
- Short answer: one definitive answer
- Explain: explain to a non-technical stakeholder
- Scenario: realistic PM context
- Explanation must be detailed enough to teach, not just confirm
- options field is required for mcq, omit or use empty array for other types`,
};

// The rendered ai-pm professor prefix (reported in code-sync). A change here changes every prompt.
const AI_PM_PREFIX = `You are the professor for the study topic "AI Product Management" (template: Knowledge).
The learner's goal: Retain the Maven AI PM course concepts well enough to use them in product work and interviews.
Learner level: working product manager. Tone: strict but fair, generous with partial credit.
Sources: Maven AI PM course concept library.

Rules for everything you write on this topic:
- Answer from this topic's sources and answer key. In a quiz request, the concepts given (names and summaries) are the answer key.
- Mark any claim the sources and answer key do not support as "unverified".
- Every question has an answer key drawn from the sources.
- When tutoring, give a hint before revealing an answer.
- When tutoring, ask one unaided recall question every 3 turns.
- Introduce at most 5 new concepts per session.`;

const EVALS = {
  id: 'evals', ownerUserId: USER, name: 'LLM Evals', goal: 'Design evals for an AI feature', targetDate: '2026-12-01',
  template: 'cert_exam', professor: { name: 'Ada', tone: 'dry and exact', level: 'senior PM' }, domain: 'ML evaluation',
  sources: [{ title: 'Evals course notes', ref: 'https://example.com/evals' }], sessionMinutes: 30, status: 'active',
};

const mcq = (conceptId) => ({
  conceptId, type: 'mcq', prompt: `About ${conceptId}?`, options: ['A. a', 'B. b', 'C. c', 'D. d'], correctAnswer: 'B', explanation: 'because',
});
const conceptsIn = (body) => JSON.parse(/\nConcepts:\n(.*)\n/.exec(body.messages[0].content)[1]).map((c) => c.id);
const echoMcqs = (body) => {
  const n = Number(/^Generate (\d+) questions/.exec(body.messages[0].content)[1]);
  const ids = conceptsIn(body);
  return Array.from({ length: n }, (_, i) => mcq(ids[i % ids.length]));
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClient() {
  const posted = [];
  const chat = {
    postMessage: async (msg) => { posted.push(msg); return { ok: true, ts: String(posted.length) }; },
    update: async () => ({ ok: true }),
    postEphemeral: async (msg) => { posted.push({ ephemeral: true, ...msg }); return { ok: true }; },
  };
  return { client: { chat }, posted };
}

let fake;
const real = { log: console.log, warn: console.warn };
beforeEach(async () => {
  fake = stubRedis();
  anthropicReplies.length = 0;
  anthropicRequests.length = 0;
  console.log = () => {};
  console.warn = () => {};
  await store.seedConcepts(USER, CONCEPTS);
});
afterEach(() => {
  Object.assign(console, real);
  fake.restore();
});

// ── Templates and spec ────────────────────────────────────────────────────────

test('T6-1: four templates, each with every policy field; mixes sum to 1', () => {
  assert.deepEqual(Object.keys(TEMPLATES), ['knowledge', 'hands_on', 'cert_exam', 'knowledge_project']);
  for (const t of Object.values(TEMPLATES)) {
    for (const k of ['hintFirst', 'retrievalCheckEvery', 'maxNewConceptsPerSession', 'drillTypes', 'itemMix', 'answerKeyRequired', 'retentionTarget', 'queueWeight']) {
      assert.ok(t[k] !== undefined, `${t.id}.${k}`);
    }
    const sum = Object.values(t.itemMix).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${t.id} mix sums to ${sum}`);
    for (const type of Object.keys(t.itemMix)) assert.ok(['mcq', 'short_answer', 'explain', 'scenario'].includes(type));
    assert.ok(t.retentionTarget > 0.7 && t.retentionTarget < 0.99);
  }
  assert.deepEqual(TEMPLATES.knowledge.itemMix, { mcq: 0.6, short_answer: 0.2, explain: 0.2 }, 'ai-pm item mix unchanged');
  assert.equal(TEMPLATES.knowledge.retentionTarget, 0.9);
});

test('T6-1: normalizeSpec fills ai-pm from the built-in spec and other topics with defaults', () => {
  const aiPm = normalizeSpec({ id: 'ai-pm' });
  assert.equal(aiPm.template, 'knowledge');
  assert.equal(aiPm.domain, 'PM');
  assert.equal(aiPm.name, AI_PM_SPEC.name);
  const other = normalizeSpec({ id: 'wine', name: 'Wine tasting', template: 'nope', status: 'gone' });
  assert.equal(other.template, 'knowledge');
  assert.equal(other.status, 'active');
  assert.equal(other.domain, 'Wine tasting');
  assert.deepEqual(other.sources, []);
});

test('T6-1: getTopicSpec — no stored row reads as the built-in spec; a stored spec wins', async () => {
  assert.equal((await getTopicSpec(store, 'ai-pm')).name, 'AI Product Management');
  await store.saveTopic(EVALS);
  const spec = await getTopicSpec(store, 'evals');
  assert.equal(spec.template, 'cert_exam');
  assert.equal(spec.professor.name, 'Ada');
});

// ── Golden: ai-pm prompts keep today's rules ──────────────────────────────────

test('T6-1 golden: the ai-pm prefix renders exactly; it is stable and carries the sources rule', () => {
  const spec = normalizeSpec({ id: 'ai-pm' });
  assert.equal(professorPrefix(spec), AI_PM_PREFIX);
  assert.equal(professorPrefix(normalizeSpec({ id: 'ai-pm' })), professorPrefix(spec), 'byte-identical across calls');
  for (const t of Object.keys(TEMPLATES)) {
    const p = professorPrefix(normalizeSpec({ id: 'x', template: t }));
    assert.match(p, /answer key/);
    assert.match(p, /"unverified"/);
  }
  assert.match(professorPrefix(normalizeSpec({ id: 'x', template: 'cert_exam' })), /no hints before the learner answers/);
});

test('T6-1 golden: questions, answer key, grading and explain-back all send the cached prefix, then today\'s task prompt', async () => {
  const spec = normalizeSpec({ id: 'ai-pm' });
  anthropicReplies.push([mcq('c1')], { isCorrect: true, score: 1, feedback: 'ok' }, { question: 'In 1–2 sentences, why does it matter?' });
  await generateQuestions({ concepts: CONCEPTS, count: 1, distribution: { mcq: 1 }, spec });
  await gradeFreeText({ prompt: 'p', correctAnswer: 'k' }, 'a', { spec });
  await tailoredExplainBackPrompt({ name: 'One', summary: 's' }, { spec });

  const [gen, grade, explain] = anthropicRequests;
  for (const r of [gen, grade, explain]) {
    assert.equal(r.system.length, 2);
    assert.equal(r.system[0].text, AI_PM_PREFIX);
    assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(r.system[1].cache_control, undefined);
  }
  assert.equal(gen.system[1].text, TODAY.question);
  assert.equal(grade.system[1].text, TODAY.grader);
  assert.equal(explain.system[1].text, TODAY.explainBack);
  assert.ok(gen.messages[0].content.includes(TODAY.questionRules), 'question rules unchanged for ai-pm');
});

test('T6-1: without a spec the prompts run as ai-pm (quizzes started before the deploy)', async () => {
  anthropicReplies.push({ isCorrect: false, score: 0, feedback: 'no' });
  await gradeFreeText({ prompt: 'p', correctAnswer: 'k' }, 'a');
  assert.equal(anthropicRequests[0].system[0].text, AI_PM_PREFIX);
});

test('T6-1: a JSON retry keeps the cached prefix first and adds the note last', async () => {
  anthropicReplies.push(() => new Response(JSON.stringify({
    id: 'm', type: 'message', role: 'assistant', model: 't', content: [{ type: 'text', text: 'not json' }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }), { ok: true });
  const out = await callJSON({ system: professorSystem(null, 'task'), user: 'u' });
  assert.deepEqual(out, { ok: true });
  const retry = anthropicRequests[1].system;
  assert.equal(retry[0].text, AI_PM_PREFIX);
  assert.equal(retry[1].text, 'task');
  assert.match(retry[2].text, /^CRITICAL: Return ONLY valid JSON/);
});

// ── Topic-aware quiz entry ────────────────────────────────────────────────────

test('T6-1: /quizinit default runs as ai-pm with the Knowledge mix and retention 0.9', async () => {
  const { client } = fakeClient();
  anthropicReplies.push(echoMcqs, echoMcqs, echoMcqs);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3 });
  await flush();
  assert.equal(quiz.topicId, 'ai-pm');
  assert.equal(quiz.retentionTarget, 0.9);
  assert.equal(anthropicRequests[0].system[0].text, AI_PM_PREFIX);
  assert.match(anthropicRequests[2].messages[0].content, /Type distribution: 60% mcq, 20% short_answer, 20% explain/);
});

test('T6-1: a quiz on another topic uses its professor, domain, template mix and retention target', async () => {
  await store.saveTopic(EVALS);
  const { client, posted } = fakeClient();
  anthropicReplies.push(echoMcqs, echoMcqs, echoMcqs);
  const quiz = await startQuiz(client, USER, SLACK_USER, CHANNEL, {}, { concepts: CONCEPTS, count: 3, topicId: 'evals' });
  await flush();
  assert.equal(quiz.topicId, 'evals');
  assert.equal(quiz.retentionTarget, TEMPLATES.cert_exam.retentionTarget);
  for (const r of anthropicRequests) {
    assert.match(r.system[0].text, /study topic "LLM Evals" \(template: Certification exam\); the learner calls you Ada\./);
    assert.match(r.system[0].text, /Target date: 2026-12-01\./);
    assert.match(r.messages[0].content, /- Scenario: realistic ML evaluation context/);
  }
  assert.match(anthropicRequests[2].messages[0].content, /Type distribution: 70% mcq, 20% scenario, 10% short_answer/);

  // The answer schedules with the topic's retention target.
  const q = quiz.questions[0];
  const value = (v) => ({ ack: async () => {}, body: { actions: [{ value: JSON.stringify(v) }], channel: { id: CHANNEL }, message: { ts: '1' }, user: { id: SLACK_USER } }, client });
  await onQuizConfidence(value({ quizId: quiz.quizId, questionId: q.id, level: 2 }));
  await onQuizAnswer(value({ quizId: quiz.quizId, questionId: q.id, letter: 'B', confidenceLevel: 2 }));
  const [event] = await store.getReviewEvents(USER);
  assert.equal(event.conceptId, q.conceptId);
  assert.ok(posted.length >= 2);
  assert.equal(pendingQuizReply(SLACK_USER, CHANNEL), null);
});

// ── DEC-060 §1/§2 ─────────────────────────────────────────────────────────────

test('DEC-060 §1: leads are due cards first, then the weakest; random only breaks ties', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const concepts = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const reviewed = (days, stability, dueInDays) => ({
    scheduler: 'fsrs', state: 2, stability, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 3, lapses: 0,
    last_review: new Date(now - days * 864e5).toISOString(), lastReviewedAt: new Date(now - days * 864e5).toISOString(),
    due: new Date(+now + dueInDays * 864e5).toISOString(), nextReviewAt: new Date(+now + dueInDays * 864e5).toISOString(),
  });
  const cards = [
    reviewed(2, 30, 10), // a: strong, not due
    reviewed(2, 3, 5), // b: weak, not due
    reviewed(10, 30, -1), // c: due, strong
    reviewed(10, 5, -1), // d: due, weaker
  ];
  assert.ok(isDue(cards[2], now) && isDue(cards[3], now) && !isDue(cards[1], now));
  assert.deepEqual(pickLeads(concepts, 4, { cards, now, random: () => 0.5 }).map((c) => c.id), ['d', 'c']);
  const notDue = [cards[0], cards[1], null, cards[0]];
  assert.deepEqual(pickLeads(concepts, 4, { cards: notDue, now, random: () => 0.5 }).map((c) => c.id)[0], 'c', 'new card (mastery 0) is weakest');

  // All equal: the random draw decides.
  const draws = [0.9, 0.1, 0.5, 0.3];
  let i = 0;
  assert.deepEqual(pickLeads(concepts, 4, { cards: [], now, random: () => draws[i++] }).map((c) => c.id), ['b', 'd']);
  assert.deepEqual(pickLeads(concepts, 5, { cards: [] }), [], 'too few concepts: no leads');
});

test('DEC-060 §2: Q2\'s type is drawn from the mix', () => {
  const mix = { mcq: 0.6, short_answer: 0.2, explain: 0.2 };
  assert.equal(sampleType(mix, () => 0), 'mcq');
  assert.equal(sampleType(mix, () => 0.59), 'mcq');
  assert.equal(sampleType(mix, () => 0.61), 'short_answer');
  assert.equal(sampleType(mix, () => 0.99), 'explain');
  const counts = {};
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let n = 0; n < 5000; n++) { const t = sampleType(mix, rand); counts[t] = (counts[t] ?? 0) + 1; }
  assert.ok(Math.abs(counts.mcq / 5000 - 0.6) < 0.03, JSON.stringify(counts));
});

// ── Retention target ──────────────────────────────────────────────────────────

test('T6-1: retention 0.9 is today\'s scheduler; another target changes the interval, not the memory state', () => {
  assert.equal(schedulerFor(0.9), scheduler);
  assert.equal(schedulerFor(undefined), scheduler);
  const now = new Date('2026-10-04T12:00:00Z');
  const card = {
    conceptId: 'c1', scheduler: 'fsrs', due: now.toISOString(), stability: 10, difficulty: 5, elapsed_days: 0, scheduled_days: 10,
    learning_steps: 0, reps: 4, lapses: 0, state: 2, last_review: new Date(now - 10 * 864e5).toISOString(),
    nextReviewAt: now.toISOString(), lastReviewedAt: new Date(now - 10 * 864e5).toISOString(),
    sm2: { easeFactor: 2.5, interval: 10, repetitions: 4, nextReviewAt: now.toISOString(), lastReviewedAt: new Date(now - 10 * 864e5).toISOString() },
  };
  const base = reviewCard(card, 3, now, 'fsrs');
  const same = reviewCard(card, 3, now, 'fsrs', { retention: 0.9 });
  const higher = reviewCard(card, 3, now, 'fsrs', { retention: 0.95 });
  assert.equal(same.next.stability, base.next.stability);
  assert.equal(higher.next.stability, base.next.stability, 'memory model unchanged');
  assert.equal(higher.next.difficulty, base.next.difficulty);
  assert.ok(higher.next.scheduled_days < base.next.scheduled_days, `${higher.next.scheduled_days} < ${base.next.scheduled_days}`);
});

// ── DEC-060 §6 ────────────────────────────────────────────────────────────────

test('DEC-060 §6: MCP get_mastery returns the computed score and R next to the stored card', async () => {
  const now = new Date();
  await store.saveCard(USER, {
    conceptId: 'c1', scheduler: 'fsrs', due: new Date(+now + 5 * 864e5).toISOString(), stability: 21, difficulty: 5, elapsed_days: 0,
    scheduled_days: 5, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: now.toISOString(),
    nextReviewAt: new Date(+now + 5 * 864e5).toISOString(), lastReviewedAt: now.toISOString(),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverSide);
  const mcp = new Client({ name: 't', version: '0' });
  await mcp.connect(clientSide);
  try {
    const rows = JSON.parse((await mcp.callTool({ name: 'get_mastery', arguments: { userId: USER } })).content[0].text);
    const c1 = rows.find((r) => r.concept.id === 'c1');
    assert.equal(c1.mastery.stability, 21);
    assert.ok(c1.score > 0.95 && c1.score <= 1, `score ${c1.score}`);
    assert.ok(c1.retrievability > 0.95, `R ${c1.retrievability}`);
    const c2 = rows.find((r) => r.concept.id === 'c2');
    assert.equal(c2.score, 0);
    assert.equal(c2.retrievability, null);
  } finally {
    await mcp.close();
  }
});
