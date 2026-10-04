import { store } from '../store/index.js';
import { libraryTopicId } from '../store/topics.js';
import { ownerConfig } from './config.js';
import { getTopicConcepts } from './concepts.js';
import { getAllMastery, isDue, masteryScore } from './mastery.js';
import { getTopicSpec, normalizeSpec } from './topicSpec.js';

// Topic-level reads and writes the Slack flows share (T6-2, DEC-046).

export const libraryTopicFor = (userId) => libraryTopicId(userId, ownerConfig().userId);
export const isLibraryTopic = (userId, topicId) => topicId === libraryTopicFor(userId);

// Until the daily planner (T6-4) reads the user's budget: minutes per day, and the time one
// review takes when the user's median is unknown.
export const DEFAULT_BUDGET_MINUTES = 20;
export const FALLBACK_REVIEW_SECONDS = 30;

// The user's topics, the library topic first (it has no stored row on the Redis backend).
export async function listUserTopics(userId) {
  const stored = await store.listTopics(userId);
  const libraryId = libraryTopicFor(userId);
  const library = stored.find((t) => t.id === libraryId);
  const rest = stored.filter((t) => t.id !== libraryId).map(normalizeSpec);
  const librarySpec = await getTopicSpec(store, libraryId);
  return [{ ...librarySpec, ownerUserId: userId, slackChannelId: library?.slackChannelId ?? null }, ...rest];
}

// The topic a Slack channel belongs to, or null (a DM, or a channel the bot did not create).
export async function topicForChannel(channelId) {
  if (!channelId || channelId.startsWith('D')) return null;
  const stored = await store.getTopicByChannel(channelId);
  return stored ? normalizeSpec(stored) : null;
}

// Due count and average mastery for one topic. Cards are read per user library today, so a
// topic other than the library reads its cards once it has concepts (T6-3).
export async function topicStats(userId, topic, now = new Date()) {
  const concepts = await getTopicConcepts(userId, topic.id);
  if (!concepts.length || !isLibraryTopic(userId, topic.id)) {
    return { conceptCount: concepts.length, due: 0, dueConcepts: [], mastery: null };
  }
  const cards = await getAllMastery(userId, concepts.map((c) => c.id));
  const dueConcepts = concepts.filter((_, i) => isDue(cards[i], now));
  const mastery = cards.reduce((sum, card) => sum + masteryScore(card, now), 0) / cards.length;
  return { conceptCount: concepts.length, due: dueConcepts.length, dueConcepts, mastery };
}

// Everything the Home tab shows. Paused and archived topics are listed but leave "Today".
export async function homeData(userId, now = new Date()) {
  const topics = await listUserTopics(userId);
  const rows = [];
  for (const topic of topics) rows.push({ topic, stats: await topicStats(userId, topic, now) });
  const active = rows.filter((r) => r.topic.status === 'active');
  const due = active.reduce((n, r) => n + r.stats.due, 0);
  return {
    today: {
      due,
      minutes: Math.ceil((due * FALLBACK_REVIEW_SECONDS) / 60),
      budgetMinutes: DEFAULT_BUDGET_MINUTES,
      budgetReviews: Math.floor((DEFAULT_BUDGET_MINUTES * 60) / FALLBACK_REVIEW_SECONDS),
    },
    topics: rows,
  };
}

// A lowercase slug that is also a valid Slack channel suffix.
export function slugify(name) {
  const slug = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'topic';
}

// A topic id not taken yet: the slug, then slug-2, slug-3, …
export async function uniqueTopicId(name) {
  const base = slugify(name);
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await store.getTopic(id)) && id !== 'ai-pm') return id;
  }
}

// Status change on a topic the user owns; the library topic is saved from its built-in spec.
export async function setTopicStatus(userId, topicId, status) {
  const topic = (await listUserTopics(userId)).find((t) => t.id === topicId);
  if (!topic) throw new Error(`Topic ${topicId} not found`);
  return store.saveTopic({ ...topic, status });
}
