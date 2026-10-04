import { store } from '../store/index.js';
import { boltApp } from './app.js';
import { getDMChannel } from './dm.js';
import { startQuiz, sourcesNeededText } from './quizFlow.js';
import { TEMPLATES } from '../lib/templates.js';
import { normalizeSpec } from '../lib/topicSpec.js';
import { getTopicConcepts } from '../lib/concepts.js';
import { homeData, listUserTopics, uniqueTopicId, setTopicStatus, isLibraryTopic, slugify } from '../lib/topics.js';

// The App Home "control panel", the New-topic / Edit-professor modal and one private channel
// per topic (design §10 slice 6, DEC-046). Every Slack call that needs a scope the app may not
// have yet fails soft: Home still renders and the user is told which permission is missing.

const MAX_QUESTIONS = 10;

// Slack Web API errors carry the API error code in `data.error`.
const slackError = (err) => err?.data?.error ?? err?.message ?? 'unknown_error';
const SCOPE_ERRORS = new Set(['missing_scope', 'not_allowed_token_type', 'no_permission', 'restricted_action']);
const isScopeError = (err) => SCOPE_ERRORS.has(slackError(err));

// ── Home view ────────────────────────────────────────────────────────────────

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const STATUS_LABEL = { active: '🟢 active', paused: '⏸️ paused', archived: '🗄️ archived' };

function topicButtons(topic, isLibrary) {
  const value = JSON.stringify({ topicId: topic.id });
  const btn = (action_id, text, extra = {}) => ({ type: 'button', action_id, text: { type: 'plain_text', text }, value, ...extra });
  if (topic.status === 'archived') return [btn('topic_restore', 'Restore')];
  const buttons = [
    btn('topic_edit', 'Edit professor'),
    topic.status === 'paused' ? btn('topic_resume', 'Resume') : btn('topic_pause', 'Pause'),
    btn('topic_archive', 'Archive', {
      confirm: {
        title: { type: 'plain_text', text: 'Archive topic?' },
        text: { type: 'mrkdwn', text: `*${topic.name}* leaves your reviews and digest. Its history and channel are kept; Restore brings it back.` },
        confirm: { type: 'plain_text', text: 'Archive' },
        deny: { type: 'plain_text', text: 'Cancel' },
      },
    }),
  ];
  if (!isLibrary && !topic.slackChannelId) buttons.push(btn('topic_channel', 'Create channel'));
  return buttons;
}

// Pure: Block Kit for the Home tab from homeData().
export function buildHomeView(data, { userId }) {
  const { today, topics } = data;
  const todayText = today.due
    ? `*Today:* ${today.due} review${today.due === 1 ? '' : 's'} due (~${today.minutes} min) · budget ${today.budgetMinutes} min`
    : `*Today:* nothing due · budget ${today.budgetMinutes} min`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'StudyBuddy' } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: todayText },
      accessory: { type: 'button', action_id: 'home_start', style: 'primary', text: { type: 'plain_text', text: 'Start' }, value: 'start' },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Topics*' },
      accessory: { type: 'button', action_id: 'home_new_topic', text: { type: 'plain_text', text: 'New topic' }, value: 'new' },
    },
  ];
  for (const { topic, stats } of topics) {
    const isLibrary = isLibraryTopic(userId, topic.id);
    const where = topic.slackChannelId ? ` · <#${topic.slackChannelId}>` : (isLibrary ? ' · in this DM' : '');
    const facts = [
      STATUS_LABEL[topic.status] ?? topic.status,
      `${stats.due} due`,
      `mastery ${pct(stats.mastery)}`,
      topic.targetDate ? `exam ${topic.targetDate}` : null,
      stats.conceptCount ? `${stats.conceptCount} concepts` : 'no concepts yet',
    ].filter(Boolean).join(' · ');
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: `*${topic.name}* — ${topic.professor.name} (${TEMPLATES[topic.template].label})${where}\n${facts}` } },
      { type: 'actions', block_id: `topic_${topic.id}`, elements: topicButtons(topic, isLibrary) },
    );
  }
  return { type: 'home', blocks };
}

export async function publishHome(client, userId, slackUserId) {
  try {
    const data = await homeData(userId);
    await client.views.publish({ user_id: slackUserId, view: buildHomeView(data, { userId }) });
  } catch (err) {
    console.error(`[home] publish failed | userId=${userId} | ${slackError(err)}`);
  }
}

// ── Topic modal (new topic / edit professor) ─────────────────────────────────

const input = (block_id, label, element, optional = true, hint = null) => ({
  type: 'input', block_id, optional, label: { type: 'plain_text', text: label }, element: { action_id: 'v', ...element },
  ...(hint && { hint: { type: 'plain_text', text: hint } }),
});
const text = (initial, extra = {}) => ({ type: 'plain_text_input', ...(initial ? { initial_value: String(initial) } : {}), ...extra });
const templateOption = (t) => ({ text: { type: 'plain_text', text: t.label }, value: t.id });

// Pure: the modal, prefilled from `spec` when editing.
export function buildTopicModal(spec = null) {
  const editing = Boolean(spec);
  const s = spec ?? normalizeSpec({ id: 'new', name: '' });
  return {
    type: 'modal',
    callback_id: editing ? 'topic_edit' : 'topic_new',
    private_metadata: editing ? JSON.stringify({ topicId: spec.id }) : '',
    title: { type: 'plain_text', text: editing ? 'Edit professor' : 'New topic' },
    submit: { type: 'plain_text', text: editing ? 'Save' : 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      input('name', 'Topic name', text(editing ? s.name : '', { max_length: 60 }), false),
      input('goal', 'Goal', text(s.goal, { multiline: true })),
      input('target_date', 'Exam / target date', { type: 'datepicker', ...(s.targetDate ? { initial_date: s.targetDate } : {}) }),
      input('template', 'Template', {
        type: 'static_select',
        options: Object.values(TEMPLATES).map(templateOption),
        initial_option: templateOption(TEMPLATES[s.template]),
      }, false),
      input('prof_name', 'Professor name', text(editing ? s.professor.name : '')),
      input('prof_tone', 'Professor tone', text(editing ? s.professor.tone : ''), true, 'e.g. warm and Socratic, dry and exact'),
      input('level', 'Your level', text(editing ? s.professor.level : ''), true, 'e.g. beginner, working PM'),
      input('sources', 'Sources', text(s.sources.map((x) => x.ref ?? x.title).join('\n'), { multiline: true }), true, 'One per line: a link or a title. Stored as references only.'),
      input('minutes', 'Minutes per session', { type: 'number_input', is_decimal_allowed: false, min_value: '5', max_value: '180', initial_value: String(s.sessionMinutes ?? 20) }, false),
    ],
  };
}

const val = (values, block) => values?.[block]?.v;

// The modal's values as spec fields, or { errors } for Slack to show next to the fields.
export function specFromModal(values) {
  const name = (val(values, 'name')?.value ?? '').trim();
  if (!name) return { errors: { name: 'Give the topic a name.' } };
  if (!/[a-z0-9]/i.test(name.normalize('NFKD'))) return { errors: { name: 'Use at least one letter or digit.' } };
  const minutes = Number(val(values, 'minutes')?.value ?? 20);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 180) return { errors: { minutes: 'Between 5 and 180 minutes.' } };
  const trimmed = (block) => (val(values, block)?.value ?? '').trim() || null;
  const sources = (val(values, 'sources')?.value ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((ref) => ({ title: ref, ref }));
  return {
    fields: {
      name,
      goal: trimmed('goal'),
      targetDate: val(values, 'target_date')?.selected_date ?? null,
      template: val(values, 'template')?.selected_option?.value ?? 'knowledge',
      professor: Object.fromEntries(Object.entries({
        name: trimmed('prof_name'), tone: trimmed('prof_tone'), level: trimmed('level'),
      }).filter(([, v]) => v)),
      sources,
      sessionMinutes: minutes,
    },
  };
}

// ── Topic channel ────────────────────────────────────────────────────────────

export function introText(spec, conceptCount) {
  const t = TEMPLATES[spec.template];
  const lines = [
    `\u{1F44B} Hi, I'm *${spec.professor.name}*, your professor for *${spec.name}* (${t.label}).`,
    spec.goal ? `Goal: ${spec.goal}` : null,
    spec.targetDate ? `Target date: ${spec.targetDate}` : null,
    'I answer from your sources and mark anything they don\'t support as "unverified". Run `/quizinit` here to be quizzed on this topic.',
  ];
  if (!conceptCount) lines.push(sourcesNeededText(spec));
  return lines.filter(Boolean).join('\n');
}

// Posts as the professor when `chat:write.customize` is granted; otherwise as the bot.
async function postAsProfessor(client, channel, spec, text) {
  try {
    await client.chat.postMessage({ channel, text, username: spec.professor.name, icon_emoji: ':mortar_board:' });
  } catch (err) {
    if (!isScopeError(err)) throw err;
    await client.chat.postMessage({ channel, text });
  }
}

// Creates `#study-<slug>` (private), invites the user and posts the professor's intro.
// Returns { ok: true, channelId } or { ok: false, reason, needed } — never throws on a scope error.
export async function createTopicChannel(client, spec, slackUserId, conceptCount = 0) {
  const base = `study-${slugify(spec.id)}`.slice(0, 76);
  let channelId = null;
  for (let n = 1; n <= 5 && !channelId; n++) {
    try {
      const res = await client.conversations.create({ name: n === 1 ? base : `${base}-${n}`, is_private: true });
      channelId = res.channel.id;
    } catch (err) {
      if (slackError(err) === 'name_taken') continue;
      if (isScopeError(err)) return { ok: false, reason: slackError(err), needed: err.data?.needed ?? 'groups:write' };
      throw err;
    }
  }
  if (!channelId) return { ok: false, reason: 'name_taken', needed: null };
  try {
    await client.conversations.invite({ channel: channelId, users: slackUserId });
  } catch (err) {
    if (slackError(err) !== 'already_in_channel') {
      console.error(`[home] invite failed | channel=${channelId} | ${slackError(err)}`);
    }
  }
  await postAsProfessor(client, channelId, spec, introText(spec, conceptCount));
  return { ok: true, channelId };
}

async function tellUser(client, slackUserId, text) {
  try {
    await client.chat.postMessage({ channel: await getDMChannel(client, slackUserId), text });
  } catch (err) {
    console.error(`[home] DM failed | ${slackError(err)}`);
  }
}

const permissionText = (spec, result) => (result.reason === 'name_taken'
  ? `⚠️ *${spec.name}* is saved, but every channel name I tried was taken. Use *Create channel* on Home after renaming one.`
  : `⚠️ *${spec.name}* is saved, but I need permission to create its channel (\`${result.needed}\`). Once the Slack app has it, press *Create channel* on Home.`);

// Creates the channel for a saved topic and records it; tells the user when it cannot.
async function attachChannel(client, userId, slackUserId, spec) {
  const conceptCount = (await getTopicConcepts(userId, spec.id)).length;
  const result = await createTopicChannel(client, spec, slackUserId, conceptCount);
  if (!result.ok) {
    await tellUser(client, slackUserId, permissionText(spec, result));
    return spec;
  }
  return store.saveTopic({ ...spec, slackChannelId: result.channelId });
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function onHomeOpened({ event, client, context }) {
  if (event.tab && event.tab !== 'home') return;
  await publishHome(client, context.userId, event.user);
}

export async function onNewTopic({ ack, body, client }) {
  await ack();
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: buildTopicModal() });
  } catch (err) {
    console.error(`[home] new-topic modal failed | ${slackError(err)}`);
  }
}

const topicIdOf = (body) => JSON.parse(body.actions[0].value).topicId;
const findTopic = async (userId, topicId) => (await listUserTopics(userId)).find((t) => t.id === topicId) ?? null;

export async function onEditTopic({ ack, body, client, context }) {
  await ack();
  try {
    const topic = await findTopic(context.userId, topicIdOf(body));
    if (!topic) return;
    await client.views.open({ trigger_id: body.trigger_id, view: buildTopicModal(topic) });
  } catch (err) {
    console.error(`[home] edit modal failed | ${slackError(err)}`);
  }
}

export async function onTopicSubmit({ ack, body, view, client, context }) {
  const parsed = specFromModal(view.state.values);
  if (parsed.errors) {
    await ack({ response_action: 'errors', errors: parsed.errors });
    return;
  }
  await ack();
  const { userId } = context;
  const slackUserId = body.user.id;
  try {
    if (view.callback_id === 'topic_edit') {
      const { topicId } = JSON.parse(view.private_metadata);
      const current = await findTopic(userId, topicId);
      if (!current) return;
      await store.saveTopic(normalizeSpec({
        ...current, ...parsed.fields, professor: { ...current.professor, ...parsed.fields.professor }, ownerUserId: userId,
      }));
    } else {
      const id = await uniqueTopicId(parsed.fields.name);
      const spec = await store.saveTopic(normalizeSpec({ ...parsed.fields, id, ownerUserId: userId, status: 'active', domain: parsed.fields.name }));
      await attachChannel(client, userId, slackUserId, spec);
    }
  } catch (err) {
    console.error(`[home] topic save failed | userId=${userId} | ${slackError(err)}`);
    await tellUser(client, slackUserId, '⚠️ Something went wrong saving that topic. Check server logs.');
  }
  await publishHome(client, userId, slackUserId);
}

function statusAction(status) {
  return async ({ ack, body, client, context }) => {
    await ack();
    try {
      await setTopicStatus(context.userId, topicIdOf(body), status);
    } catch (err) {
      console.error(`[home] status ${status} failed | ${slackError(err)}`);
    }
    await publishHome(client, context.userId, body.user.id);
  };
}

export const onPauseTopic = statusAction('paused');
export const onResumeTopic = statusAction('active');
export const onArchiveTopic = statusAction('archived');
export const onRestoreTopic = statusAction('active');

export async function onCreateChannel({ ack, body, client, context }) {
  await ack();
  try {
    const topic = await findTopic(context.userId, topicIdOf(body));
    if (topic && !topic.slackChannelId) await attachChannel(client, context.userId, body.user.id, topic);
  } catch (err) {
    console.error(`[home] create channel failed | ${slackError(err)}`);
  }
  await publishHome(client, context.userId, body.user.id);
}

// Start: a quiz in the DM on the active topic with the most due cards (the cross-topic queue is
// the daily planner, T6-4), on its due concepts; with nothing due, an ordinary quiz on ai-pm.
export async function onHomeStart({ ack, body, client, context }) {
  await ack();
  const { userId } = context;
  const slackUserId = body.user.id;
  try {
    const { topics } = await homeData(userId);
    const best = topics.filter((r) => r.topic.status === 'active' && r.stats.due > 0)
      .sort((a, b) => b.stats.due - a.stats.due)[0];
    const channelId = await getDMChannel(client, slackUserId);
    await startQuiz(client, userId, slackUserId, channelId, {}, best
      ? { trigger: 'home_start', topicId: best.topic.id, concepts: best.stats.dueConcepts, count: Math.min(MAX_QUESTIONS, best.stats.dueConcepts.length) }
      : { trigger: 'home_start' });
  } catch (err) {
    console.error(`[home] start failed | userId=${userId} | ${slackError(err)}`);
    await tellUser(client, slackUserId, '⚠️ Something went wrong starting the quiz. Check server logs.');
  }
}

export function registerHomeHandlers() {
  boltApp.event('app_home_opened', onHomeOpened);
  boltApp.action('home_start', onHomeStart);
  boltApp.action('home_new_topic', onNewTopic);
  boltApp.action('topic_edit', onEditTopic);
  boltApp.action('topic_pause', onPauseTopic);
  boltApp.action('topic_resume', onResumeTopic);
  boltApp.action('topic_archive', onArchiveTopic);
  boltApp.action('topic_restore', onRestoreTopic);
  boltApp.action('topic_channel', onCreateChannel);
  boltApp.view('topic_new', onTopicSubmit);
  boltApp.view('topic_edit', onTopicSubmit);
}
