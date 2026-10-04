import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubRedis } from './helpers/fakeRedis.js';
import { stubAnthropic } from './helpers/anthropicStub.js';

// Installed before the app modules load; see helpers/anthropicStub.js.
const { replies: anthropicReplies, requests: anthropicRequests } = stubAnthropic();

const { store } = await import('../src/store/index.js');
const home = await import('../src/slack/homeFlow.js');
const { startQuiz } = await import('../src/slack/quizFlow.js');
const { homeData, topicForChannel, slugify, uniqueTopicId } = await import('../src/lib/topics.js');
const { getTopicSpec } = await import('../src/lib/topicSpec.js');

const USER = 'test-user';
const SLACK_USER = 'UOWNER';
const DM = 'D1';
const CONCEPTS = [
  { id: 'c1', name: 'One', summary: 'one summary' },
  { id: 'c2', name: 'Two', summary: 'two summary' },
  { id: 'c3', name: 'Three', summary: 'three summary' },
];

const apiError = (error, extra = {}) => Object.assign(new Error(`An API error occurred: ${error}`), { data: { ok: false, error, ...extra } });

// A Slack Web API double: records every call; `fail[method]` makes that method throw.
function fakeSlack({ fail = {} } = {}) {
  const calls = [];
  let channels = 0;
  const call = (method, impl) => async (args) => {
    calls.push({ method, args });
    const f = fail[method];
    if (f) {
      const err = typeof f === 'function' ? f(args) : f;
      if (err) throw err;
    }
    return impl(args);
  };
  const client = {
    chat: {
      postMessage: call('chat.postMessage', () => ({ ok: true, ts: String(calls.length) })),
      update: call('chat.update', () => ({ ok: true })),
      postEphemeral: call('chat.postEphemeral', () => ({ ok: true })),
    },
    conversations: {
      open: call('conversations.open', () => ({ ok: true, channel: { id: DM } })),
      create: call('conversations.create', (args) => ({ ok: true, channel: { id: `G${++channels}`, name: args.name } })),
      invite: call('conversations.invite', () => ({ ok: true })),
    },
    views: {
      publish: call('views.publish', () => ({ ok: true })),
      open: call('views.open', () => ({ ok: true })),
    },
  };
  const of = (method) => calls.filter((c) => c.method === method).map((c) => c.args);
  return { client, calls, of };
}

// Modal state as Slack sends it on view_submission.
function modalValues({ name = 'LLM Evals', goal = '', date = null, template = 'cert_exam', profName = 'Ada', tone = '', level = '', sources = '', minutes = '30' } = {}) {
  return {
    name: { v: { type: 'plain_text_input', value: name } },
    goal: { v: { type: 'plain_text_input', value: goal } },
    target_date: { v: { type: 'datepicker', selected_date: date } },
    template: { v: { type: 'static_select', selected_option: { value: template } } },
    prof_name: { v: { type: 'plain_text_input', value: profName } },
    prof_tone: { v: { type: 'plain_text_input', value: tone } },
    level: { v: { type: 'plain_text_input', value: level } },
    sources: { v: { type: 'plain_text_input', value: sources } },
    minutes: { v: { type: 'number_input', value: minutes } },
  };
}

const context = () => ({ userId: USER });
async function submit(client, callbackId, values, privateMetadata = '') {
  let acked;
  await home.onTopicSubmit({
    ack: async (arg) => { acked = arg ?? null; },
    body: { user: { id: SLACK_USER } },
    view: { callback_id: callbackId, private_metadata: privateMetadata, state: { values } },
    client,
    context: context(),
  });
  return acked;
}
const press = (handler, client, topicId) => handler({
  ack: async () => {}, body: { user: { id: SLACK_USER }, trigger_id: 'trig', actions: [{ value: JSON.stringify({ topicId }) }] }, client, context: context(),
});

const homeText = (view) => view.blocks.map((b) => b.text?.text ?? '').join('\n');
const flush = () => new Promise((resolve) => setImmediate(resolve));

let fake;
let errors;
const real = { log: console.log, warn: console.warn, error: console.error };
beforeEach(async () => {
  fake = stubRedis();
  anthropicReplies.length = 0;
  anthropicRequests.length = 0;
  errors = [];
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args) => errors.push(args.join(' '));
  await store.seedConcepts(USER, CONCEPTS);
});
afterEach(() => {
  Object.assign(console, real);
  fake.restore();
});

const dueCard = (conceptId) => {
  const past = new Date(Date.now() - 10 * 864e5).toISOString();
  const due = new Date(Date.now() - 864e5).toISOString();
  return {
    conceptId, scheduler: 'fsrs', due, stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 9, learning_steps: 0,
    reps: 3, lapses: 0, state: 2, last_review: past, lastReviewedAt: past, nextReviewAt: due,
  };
};

// ── Home tab ─────────────────────────────────────────────────────────────────

test('T6-2 Home: Today counts due cards of active topics; topic list shows status, due, mastery, exam date', async () => {
  await store.saveCard(USER, dueCard('c1'));
  await store.saveCard(USER, dueCard('c2'));
  await store.saveTopic({ ...(await getTopicSpec(store, 'evals')), name: 'LLM Evals', ownerUserId: USER, template: 'cert_exam', targetDate: '2026-12-01' });
  const { client, of } = fakeSlack();
  await home.onHomeOpened({ event: { user: SLACK_USER, tab: 'home' }, client, context: context() });
  const [{ user_id, view }] = of('views.publish');
  assert.equal(user_id, SLACK_USER);
  assert.equal(view.type, 'home');
  const text = homeText(view);
  assert.match(text, /\*Today:\* 2 reviews due \(~1 min\) · budget 20 min/);
  assert.match(text, /\*AI Product Management\* — Professor \(Knowledge\) · in this DM\n🟢 active · 2 due · mastery \d+% · 3 concepts/);
  assert.match(text, /\*LLM Evals\* — Professor \(Certification exam\)\n🟢 active · 0 due · mastery — · exam 2026-12-01 · no concepts yet/);
  const actions = view.blocks.filter((b) => b.type === 'actions');
  assert.deepEqual(actions[0].elements.map((e) => e.action_id), ['topic_edit', 'topic_pause', 'topic_archive']);
  assert.deepEqual(actions[1].elements.map((e) => e.action_id), ['topic_edit', 'topic_pause', 'topic_archive', 'topic_channel']);
  assert.ok(view.blocks.some((b) => b.accessory?.action_id === 'home_start'));
  assert.ok(view.blocks.some((b) => b.accessory?.action_id === 'home_new_topic'));
});

test('T6-2 Home: pausing leaves Today, archiving leaves only Restore; both are soft and reversible', async () => {
  await store.saveCard(USER, dueCard('c1'));
  const { client, of } = fakeSlack();
  await press(home.onPauseTopic, client, 'ai-pm');
  assert.equal((await getTopicSpec(store, 'ai-pm')).status, 'paused');
  assert.equal((await homeData(USER)).today.due, 0);
  assert.match(homeText(of('views.publish').at(-1).view), /⏸️ paused · 1 due/);

  await press(home.onArchiveTopic, client, 'ai-pm');
  const archived = of('views.publish').at(-1).view.blocks.filter((b) => b.type === 'actions')[0];
  assert.deepEqual(archived.elements.map((e) => e.action_id), ['topic_restore']);
  await press(home.onRestoreTopic, client, 'ai-pm');
  assert.equal((await homeData(USER)).today.due, 1);
  assert.equal((await store.getConcepts(USER)).length, 3, 'library untouched');
});

test('T6-2 Home: a Home error is logged, never thrown', async () => {
  const { client } = fakeSlack({ fail: { 'views.publish': apiError('not_enabled') } });
  await home.onHomeOpened({ event: { user: SLACK_USER, tab: 'home' }, client, context: context() });
  assert.match(errors.join('\n'), /\[home\] publish failed .* not_enabled/);
});

// ── New topic ────────────────────────────────────────────────────────────────

test('T6-2 New topic: modal → topic row, private #study-<slug>, user invited, professor intro asks for sources', async () => {
  const { client, of } = fakeSlack();
  await home.onNewTopic({ ack: async () => {}, body: { trigger_id: 'trig' }, client });
  const modal = of('views.open')[0].view;
  assert.equal(modal.callback_id, 'topic_new');
  assert.deepEqual(modal.blocks.map((b) => b.block_id), ['name', 'goal', 'target_date', 'template', 'prof_name', 'prof_tone', 'level', 'sources', 'minutes']);
  assert.equal(modal.blocks.find((b) => b.block_id === 'template').element.options.length, 4);

  const acked = await submit(client, 'topic_new', modalValues({
    name: 'LLM Evals!', goal: 'Ship an eval suite', date: '2026-12-01', tone: 'dry', level: 'senior PM', sources: 'https://a.example\nEvals book',
  }));
  assert.equal(acked, null, 'plain ack');
  const topic = await store.getTopic('llm-evals');
  assert.equal(topic.name, 'LLM Evals!');
  assert.equal(topic.template, 'cert_exam');
  assert.equal(topic.status, 'active');
  assert.equal(topic.ownerUserId, USER);
  assert.deepEqual(topic.professor, { name: 'Ada', tone: 'dry', level: 'senior PM' });
  assert.deepEqual(topic.sources, [{ title: 'https://a.example', ref: 'https://a.example' }, { title: 'Evals book', ref: 'Evals book' }]);
  assert.equal(topic.sessionMinutes, 30);
  assert.equal(topic.targetDate, '2026-12-01');
  assert.equal(topic.slackChannelId, 'G1');

  assert.deepEqual(of('conversations.create'), [{ name: 'study-llm-evals', is_private: true }]);
  assert.deepEqual(of('conversations.invite'), [{ channel: 'G1', users: SLACK_USER }]);
  const intro = of('chat.postMessage').find((m) => m.channel === 'G1');
  assert.equal(intro.username, 'Ada');
  assert.match(intro.text, /I'm \*Ada\*, your professor for \*LLM Evals!\* \(Certification exam\)/);
  assert.match(intro.text, /don't have any material for this topic yet/);
  assert.match(intro.text, /"unverified"/);
  assert.equal((await topicForChannel('G1')).id, 'llm-evals');
  assert.match(homeText(of('views.publish').at(-1).view), /\*LLM Evals!\* — Ada \(Certification exam\) · <#G1>/);
});

test('T6-2 New topic: missing groups:write → topic saved, user told which permission, Home still renders', async () => {
  const { client, of } = fakeSlack({ fail: { 'conversations.create': apiError('missing_scope', { needed: 'groups:write' }) } });
  await submit(client, 'topic_new', modalValues());
  const topic = await store.getTopic('llm-evals');
  assert.equal(topic.slackChannelId, null);
  const dm = of('chat.postMessage').find((m) => m.channel === DM);
  assert.match(dm.text, /saved, but I need permission to create its channel \(`groups:write`\)/);
  const view = of('views.publish').at(-1).view;
  const evals = view.blocks.filter((b) => b.type === 'actions')[1];
  assert.ok(evals.elements.some((e) => e.action_id === 'topic_channel'), 'Create channel offered');

  // Once the scope is granted, Create channel finishes the job.
  const ok = fakeSlack();
  await press(home.onCreateChannel, ok.client, 'llm-evals');
  assert.equal((await store.getTopic('llm-evals')).slackChannelId, 'G1');
});

test('T6-2 New topic: without chat:write.customize the intro posts as the bot; a taken name gets a suffix', async () => {
  const { client, of } = fakeSlack({
    fail: {
      'chat.postMessage': (args) => (args.username ? apiError('missing_scope', { needed: 'chat:write.customize' }) : null),
      'conversations.create': (args) => (args.name === 'study-llm-evals' ? apiError('name_taken') : null),
    },
  });
  await submit(client, 'topic_new', modalValues());
  assert.deepEqual(of('conversations.create').map((a) => a.name), ['study-llm-evals', 'study-llm-evals-2']);
  const intros = of('chat.postMessage').filter((m) => m.channel === 'G1');
  assert.equal(intros.length, 2);
  assert.equal(intros[1].username, undefined);
  assert.equal((await store.getTopic('llm-evals')).slackChannelId, 'G1');
});

test('T6-2 New topic: validation errors go back to the modal; a second topic with the same name gets its own id', async () => {
  const { client } = fakeSlack();
  assert.deepEqual(await submit(client, 'topic_new', modalValues({ name: '  ' })), { response_action: 'errors', errors: { name: 'Give the topic a name.' } });
  assert.deepEqual(await submit(client, 'topic_new', modalValues({ minutes: '2' })), { response_action: 'errors', errors: { minutes: 'Between 5 and 180 minutes.' } });
  await submit(client, 'topic_new', modalValues());
  assert.equal(await uniqueTopicId('LLM Evals'), 'llm-evals-2');
  assert.equal(slugify('Wine — Tasting 101 ✨'), 'wine-tasting-101');
  assert.equal(await uniqueTopicId('AI PM'), 'ai-pm-2', 'never the library id');
});

// ── Edit professor ───────────────────────────────────────────────────────────

test('T6-2 Edit professor: prefilled modal; saving changes the spec the prompts use; channel kept', async () => {
  const { client, of } = fakeSlack();
  await submit(client, 'topic_new', modalValues({ tone: 'dry' }));
  await press(home.onEditTopic, client, 'llm-evals');
  const modal = of('views.open').at(-1).view;
  assert.equal(modal.callback_id, 'topic_edit');
  assert.equal(modal.blocks.find((b) => b.block_id === 'prof_tone').element.initial_value, 'dry');
  assert.equal(modal.blocks.find((b) => b.block_id === 'template').element.initial_option.value, 'cert_exam');

  await submit(client, 'topic_edit', modalValues({ tone: 'warm', template: 'knowledge_project', profName: '' }), modal.private_metadata);
  const spec = await getTopicSpec(store, 'llm-evals');
  assert.equal(spec.professor.tone, 'warm');
  assert.equal(spec.professor.name, 'Ada', 'blank field keeps the old value');
  assert.equal(spec.template, 'knowledge_project');
  assert.equal(spec.slackChannelId, 'G1');
  assert.equal(of('conversations.create').length, 1, 'no second channel');
});

test('T6-2 Edit professor on ai-pm stores its spec; the quiz prefix follows', async () => {
  const { client } = fakeSlack();
  await submit(client, 'topic_edit', modalValues({ name: 'AI Product Management', template: 'knowledge', profName: 'Dr. PM', minutes: '20' }), JSON.stringify({ topicId: 'ai-pm' }));
  const spec = await getTopicSpec(store, 'ai-pm');
  assert.equal(spec.professor.name, 'Dr. PM');
  assert.equal(spec.domain, 'PM');
  anthropicReplies.push([{ conceptId: 'c1', type: 'mcq', prompt: 'P?', options: ['A. a', 'B. b'], correctAnswer: 'A', explanation: 'e' }]);
  await startQuiz(client, USER, SLACK_USER, DM, {}, { concepts: [CONCEPTS[0]], count: 1 });
  assert.match(anthropicRequests[0].system[0].text, /the learner calls you Dr\. PM\./);
});

// ── Topic channels ───────────────────────────────────────────────────────────

test('T6-2 channel: /quizinit in a topic channel runs on that topic; with no concepts its professor asks for sources', async () => {
  const { client, of } = fakeSlack();
  await submit(client, 'topic_new', modalValues());
  assert.equal(await topicForChannel(DM), null, 'the DM is not a topic channel');
  const topic = await topicForChannel('G1');
  const quiz = await startQuiz(client, USER, SLACK_USER, 'G1', { mode: 'all' }, { topicId: topic.id });
  assert.equal(quiz, null);
  assert.equal(anthropicRequests.length, 0);
  assert.match(of('chat.postMessage').at(-1).text, /I'm Ada, your professor for \*LLM Evals\*. I don't have any material/);
});

test('T6-2 channel: the DM keeps quizzing ai-pm', async () => {
  const { client } = fakeSlack();
  anthropicReplies.push((body) => [{ conceptId: 'c1', type: 'mcq', prompt: 'P?', options: ['A. a', 'B. b'], correctAnswer: 'A', explanation: 'e' }]);
  const quiz = await startQuiz(client, USER, SLACK_USER, DM, { mode: 'all' }, { count: 1 });
  assert.equal(quiz.topicId, 'ai-pm');
});

// ── Start ────────────────────────────────────────────────────────────────────

test('T6-2 Start: quiz in the DM on the due concepts of the topic with most due', async () => {
  await store.saveCard(USER, dueCard('c2'));
  const { client } = fakeSlack();
  anthropicReplies.push([{ conceptId: 'c2', type: 'mcq', prompt: 'P?', options: ['A. a', 'B. b'], correctAnswer: 'A', explanation: 'e' }]);
  await home.onHomeStart({ ack: async () => {}, body: { user: { id: SLACK_USER } }, client, context: context() });
  await flush();
  const quizId = await store.getActiveQuizId(USER);
  const quiz = await store.getQuiz(quizId);
  assert.equal(quiz.trigger, 'home_start');
  assert.equal(quiz.slackChannelId, DM);
  assert.equal(quiz.topicId, 'ai-pm');
  assert.deepEqual(quiz.questions.map((q) => q.conceptId), ['c2']);
  assert.match(anthropicRequests[0].messages[0].content, /"id":"c2"/);
  assert.doesNotMatch(anthropicRequests[0].messages[0].content, /"id":"c1"/);
});
