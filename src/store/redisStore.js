import { applyConceptUpdate, mergeNewConcepts } from '../mcp/conceptOps.js';
import { libraryTopicId } from './topics.js';

const HISTORY_LIMIT = 30;

// @upstash/redis already JSON-parses stored values; plain strings still need it.
function parse(raw) {
  if (raw == null) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const keys = {
  concepts: (userId) => `concepts:${userId}`,
  mastery: (userId, conceptId) => `mastery:${userId}:${conceptId}`,
  quiz: (quizId) => `quiz:${quizId}`,
  activeQuiz: (userId) => `active-quiz:${userId}`,
  history: (userId) => `history:${userId}`,
  session: (userId) => `session:${userId}`,
  settings: (userId) => `settings:${userId}`,
  snapshot: (userId, day) => `mastery-snapshot:${userId}:${day}`,
  reviewEvents: (userId) => `review-events:${userId}`,
  retests: (userId, day) => `retests:${userId}:${day}`,
  topic: (topicId) => `topic:${topicId}`,
  topicIds: (userId) => `topic-ids:${userId}`,
  topicChannel: (channelId) => `topic-channel:${channelId}`,
  topicConcepts: (userId, topicId) => `concepts:${userId}:${topicId}`,
};

const RETEST_KEY_TTL_S = 2 * 24 * 60 * 60;

// Today's Redis layout behind the store interface (see store/index.js). Key names are
// unchanged so existing production data keeps working.
export function createRedisStore({ redis, primaryUserId = null }) {
  const getConcepts = async (userId) => parse(await redis.get(keys.concepts(userId))) ?? [];
  const setConcepts = (userId, concepts) => redis.set(keys.concepts(userId), JSON.stringify(concepts));

  return {
    backend: 'redis',
    async init() {},
    async close() {},

    getConcepts,

    async seedConcepts(userId, concepts) {
      if (await redis.get(keys.concepts(userId))) return false;
      await setConcepts(userId, concepts);
      return true;
    },

    async addConcepts(userId, concepts) {
      const { added, merged } = mergeNewConcepts(await getConcepts(userId), concepts);
      await setConcepts(userId, merged);
      return { added, total: merged.length };
    },

    async updateConcept(userId, conceptId, updates) {
      const concepts = await getConcepts(userId);
      const idx = concepts.findIndex((c) => c.id === conceptId);
      if (idx === -1) return null;
      concepts[idx] = applyConceptUpdate(concepts[idx], updates);
      await setConcepts(userId, concepts);
      return concepts[idx];
    },

    async deleteConcept(userId, conceptId) {
      const concepts = await getConcepts(userId);
      const remaining = concepts.filter((c) => c.id !== conceptId);
      if (remaining.length === concepts.length) return null;
      await setConcepts(userId, remaining);
      return remaining.length;
    },

    async getCards(userId, conceptIds) {
      if (conceptIds.length === 0) return [];
      const values = await redis.mget(...conceptIds.map((id) => keys.mastery(userId, id)));
      return values.map(parse);
    },

    async saveCard(userId, card) {
      await redis.set(keys.mastery(userId, card.conceptId), JSON.stringify(card));
    },

    getQuiz: async (quizId) => parse(await redis.get(keys.quiz(quizId))),
    saveQuiz: async (quiz) => { await redis.set(keys.quiz(quiz.quizId), JSON.stringify(quiz)); },
    deleteQuiz: async (quizId) => { await redis.del(keys.quiz(quizId)); },
    getActiveQuizId: async (userId) => (await redis.get(keys.activeQuiz(userId))) ?? null,
    setActiveQuizId: async (userId, quizId) => { await redis.set(keys.activeQuiz(userId), quizId); },
    clearActiveQuizId: async (userId) => { await redis.del(keys.activeQuiz(userId)); },

    async addHistory(userId, entry) {
      await redis.lpush(keys.history(userId), JSON.stringify(entry));
      await redis.ltrim(keys.history(userId), 0, HISTORY_LIMIT - 1);
    },

    async getHistory(userId, limit, { excludeTriggers = [] } = {}) {
      if (excludeTriggers.length === 0) return (await redis.lrange(keys.history(userId), 0, limit - 1)).map(parse);
      const all = (await redis.lrange(keys.history(userId), 0, -1)).map(parse);
      return all.filter((e) => !excludeTriggers.includes(e.trigger)).slice(0, limit);
    },

    // Topic specs (lib/topicSpec.js), one JSON value per topic plus each owner's id list.
    getTopic: async (topicId) => parse(await redis.get(keys.topic(topicId))),

    async saveTopic(topic) {
      if (!topic.ownerUserId) throw new Error('saveTopic: ownerUserId is required');
      const prev = parse(await redis.get(keys.topic(topic.id)));
      if (prev && prev.ownerUserId !== topic.ownerUserId) throw new Error(`saveTopic: topic ${topic.id} belongs to another user`);
      if (topic.slackChannelId) {
        const holder = parse(await redis.get(keys.topicChannel(topic.slackChannelId)))?.topicId;
        if (holder && holder !== topic.id) throw new Error(`saveTopic: channel ${topic.slackChannelId} already belongs to topic ${holder}`);
      }
      await redis.set(keys.topic(topic.id), JSON.stringify(topic));
      if (prev?.slackChannelId && prev.slackChannelId !== topic.slackChannelId) await redis.del(keys.topicChannel(prev.slackChannelId));
      // An object, not a bare string: Upstash would hand a JSON string back already parsed.
      if (topic.slackChannelId) await redis.set(keys.topicChannel(topic.slackChannelId), JSON.stringify({ topicId: topic.id }));
      const ids = parse(await redis.get(keys.topicIds(topic.ownerUserId))) ?? [];
      if (!ids.includes(topic.id)) await redis.set(keys.topicIds(topic.ownerUserId), JSON.stringify([...ids, topic.id]));
      return topic;
    },

    async getTopicByChannel(channelId) {
      const topicId = parse(await redis.get(keys.topicChannel(channelId)))?.topicId;
      return topicId ? parse(await redis.get(keys.topic(topicId))) : null;
    },

    // A topic's concepts in library order; the user's library topic is getConcepts(userId).
    async getTopicConcepts(userId, topicId) {
      if (topicId === libraryTopicId(userId, primaryUserId)) return getConcepts(userId);
      return parse(await redis.get(keys.topicConcepts(userId, topicId))) ?? [];
    },

    async listTopics(userId) {
      const ids = parse(await redis.get(keys.topicIds(userId))) ?? [];
      if (!ids.length) return [];
      return (await redis.mget(...ids.map(keys.topic))).map(parse).filter(Boolean);
    },

    getSession: async (userId) => parse(await redis.get(keys.session(userId))),
    saveSession: async (userId, session) => { await redis.set(keys.session(userId), JSON.stringify(session)); },

    getSettings: async (userId) => parse(await redis.get(keys.settings(userId))),
    saveSettings: async (userId, settings) => { await redis.set(keys.settings(userId), JSON.stringify(settings)); },

    getMasterySnapshot: async (userId, day) => parse(await redis.get(keys.snapshot(userId, day))),
    saveMasterySnapshot: async (userId, day, record) => {
      await redis.set(keys.snapshot(userId, day), JSON.stringify(record));
    },

    // Retest slots for one user-day, as a JSON list of `${quizId}:${conceptId}` (DEC-058 §1).
    // Read-modify-write: one bot instance and one user, so no concurrent claimers.
    async claimRetest(userId, day, key, cap) {
      const k = keys.retests(userId, day);
      const claimed = parse(await redis.get(k)) ?? [];
      if (claimed.includes(key)) return 'duplicate';
      if (claimed.length >= cap) return 'over_cap';
      await redis.set(k, JSON.stringify([...claimed, key]), { ex: RETEST_KEY_TTL_S });
      return 'claimed';
    },

    // Append-only: events are only ever LPUSHed, never trimmed or rewritten.
    async appendReviewEvent(event) {
      const stored = {
        ...event,
        topicId: event.topicId ?? libraryTopicId(event.userId, primaryUserId),
        ts: event.ts ?? new Date().toISOString(),
      };
      await redis.lpush(keys.reviewEvents(event.userId), JSON.stringify(stored));
      return stored;
    },

    async getReviewEvents(userId, { topicId, since, limit = 100 } = {}) {
      const key = keys.reviewEvents(userId);
      if (!topicId && !since) return (await redis.lrange(key, 0, limit - 1)).map(parse);
      const sinceMs = since ? Date.parse(since) : null;
      return (await redis.lrange(key, 0, -1)).map(parse)
        .filter((e) => (!topicId || e.topicId === topicId) && (sinceMs == null || Date.parse(e.ts) >= sinceMs))
        .slice(0, limit);
    },
  };
}
