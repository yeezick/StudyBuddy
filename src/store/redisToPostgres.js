import { isDeepStrictEqual } from 'node:util';
import { createRedisStore } from './redisStore.js';
import { createPostgresStore, libraryTopicId } from './postgresStore.js';

// Copies production records from today's Redis keys into Postgres (design §10 slice 3).
// Redis is only read, never written: it stays as the rollback (STORE_BACKEND unset → redis).
// Queues, quizzes and the active-quiz pointer stay in Redis (DEC-047); review events are
// slice 4 and are only counted here.

export const TABLES = ['users', 'topics', 'concepts', 'cards', 'quiz_history', 'sessions', 'mastery_snapshots'];

// Only the commands this module uses. Anything else throws, so a write can't slip in.
const READ_COMMANDS = new Set(['get', 'mget', 'scan', 'lrange']);
export function readOnly(redis) {
  return new Proxy(redis, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (!READ_COMMANDS.has(prop)) throw new Error(`redisToPostgres: Redis is read-only here (tried ${String(prop)})`);
      return value.bind(target);
    },
  });
}

// @upstash/redis JSON-parses stored values already; plain strings still need it.
function parse(raw) {
  if (raw == null || typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw; }
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// The app writes ISO strings (toISOString); Postgres casts those to timestamptz.
const validTs = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
// Key-order-independent JSON, matching how jsonb compares values.
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Key layout from redisStore.js. The user id is everything between the prefix and the last
// colon (concept ids and days never contain one), so user ids with colons still parse.
const RECORD_KEYS = [
  { prefix: 'concepts:', kind: 'concepts' },
  { prefix: 'mastery:', kind: 'card', suffixed: true },
  { prefix: 'history:', kind: 'history' },
  { prefix: 'session:', kind: 'session' },
  { prefix: 'settings:', kind: 'settings' },
  { prefix: 'mastery-snapshot:', kind: 'snapshot', suffixed: true },
  { prefix: 'review-events:', kind: 'reviewEvents' },
];
// Stay in Redis by design.
const REDIS_ONLY = ['quiz:', 'active-quiz:', 'bull:'];

export function classifyKey(key) {
  for (const { prefix, kind, suffixed } of RECORD_KEYS) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!suffixed) return rest ? { kind, userId: rest } : { kind: 'unmapped' };
    const cut = rest.lastIndexOf(':');
    if (cut <= 0 || cut === rest.length - 1) return { kind: 'unmapped' };
    return { kind, userId: rest.slice(0, cut), sub: rest.slice(cut + 1) };
  }
  if (REDIS_ONLY.some((p) => key.startsWith(p))) return { kind: 'redisOnly' };
  return { kind: 'unmapped' };
}

async function scanAll(redis) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, page] = await redis.scan(cursor, { match: '*', count: 1000 });
    keys.push(...page);
    cursor = String(next);
  } while (cursor !== '0');
  return keys;
}

async function mgetChunked(redis, keys, size = 100) {
  const out = [];
  for (let i = 0; i < keys.length; i += size) out.push(...(await redis.mget(...keys.slice(i, i + size))));
  return out;
}

// Reads every Redis record and maps it to Postgres rows for the users given. Pure read.
// Returns { users: { [userId]: plan }, otherUsers, redisOnlyKeys, unmapped: [{ key, reason }] }.
export async function readRedis(rawRedis, { userIds, primaryUserId }) {
  const redis = readOnly(rawRedis);
  const wanted = new Set(userIds);
  const unmapped = [];
  const otherUsers = {};
  let redisOnlyKeys = 0;
  const byUser = new Map(userIds.map((u) => [u, []]));

  for (const key of await scanAll(redis)) {
    const c = classifyKey(key);
    if (c.kind === 'redisOnly') { redisOnlyKeys++; continue; }
    if (c.kind === 'unmapped') { unmapped.push({ key, reason: 'unknown key pattern' }); continue; }
    if (!wanted.has(c.userId)) { otherUsers[c.userId] = (otherUsers[c.userId] ?? 0) + 1; continue; }
    byUser.get(c.userId).push({ key, ...c });
  }

  const users = {};
  for (const userId of userIds) {
    const entries = byUser.get(userId);
    const of = (kind) => entries.filter((e) => e.kind === kind);
    const topicId = libraryTopicId(userId, primaryUserId);
    const plan = {
      topicId, settings: null, concepts: [], cards: [], history: [], session: null, snapshots: [], reviewEvents: 0,
    };
    const skip = (key, reason) => unmapped.push({ key, reason });

    // String values, fetched in one pass.
    const stringKeys = entries.filter((e) => !['history', 'reviewEvents'].includes(e.kind));
    const values = await mgetChunked(redis, stringKeys.map((e) => e.key));
    const value = new Map(stringKeys.map((e, i) => [e.key, parse(values[i])]));

    for (const { key } of of('settings')) {
      const v = value.get(key);
      if (isObject(v)) plan.settings = v; else skip(key, 'settings is not an object');
    }

    for (const { key } of of('concepts')) {
      const list = value.get(key);
      if (!Array.isArray(list)) { skip(key, 'concept library is not an array'); continue; }
      const seen = new Set();
      list.forEach((concept, i) => {
        if (!isObject(concept) || typeof concept.id !== 'string' || !concept.id) return skip(`${key}[${i}]`, 'concept without an id');
        if (seen.has(concept.id)) return skip(`${key}[${i}]`, `duplicate concept id ${concept.id}`);
        seen.add(concept.id);
        plan.concepts.push(concept);
      });
    }

    for (const { key, sub: conceptId } of of('card')) {
      const card = value.get(key);
      if (!isObject(card)) { skip(key, 'card is not an object'); continue; }
      if (card.conceptId !== conceptId) { skip(key, `card.conceptId "${card.conceptId}" does not match its key`); continue; }
      if (card.nextReviewAt != null && !validTs(card.nextReviewAt)) { skip(key, 'card.nextReviewAt is not a timestamp'); continue; }
      plan.cards.push(card);
    }

    for (const { key, sub: day } of of('snapshot')) {
      const record = value.get(key);
      if (!DAY.test(day) || Number.isNaN(Date.parse(day))) { skip(key, 'snapshot day is not YYYY-MM-DD'); continue; }
      if (record == null) { skip(key, 'snapshot is empty'); continue; }
      plan.snapshots.push({ day, record });
    }

    for (const { key } of of('session')) {
      const s = value.get(key);
      if (!isObject(s) || typeof s.sessionId !== 'string' || !s.sessionId) { skip(key, 'session without a sessionId'); continue; }
      const bad = ['startedAt', 'completedAt'].find((f) => s[f] != null && !validTs(s[f]));
      if (bad) { skip(key, `session.${bad} is not a timestamp`); continue; }
      plan.session = s;
    }

    for (const { key } of of('history')) {
      // Redis keeps newest first; Postgres orders by insertion, so write oldest first.
      const list = (await redis.lrange(key, 0, -1)).map(parse);
      list.forEach((entry, i) => {
        if (!isObject(entry)) return skip(`${key}[${i}]`, 'history entry is not an object');
        if (entry.completedAt != null && !validTs(entry.completedAt)) return skip(`${key}[${i}]`, 'history.completedAt is not a timestamp');
        plan.history.unshift(entry);
      });
    }

    for (const { key } of of('reviewEvents')) plan.reviewEvents += (await redis.lrange(key, 0, -1)).length;

    users[userId] = plan;
  }
  return { users, otherUsers, redisOnlyKeys, unmapped };
}

// Rows each table gets for one user's plan.
export function planCounts(plan) {
  return {
    users: 1,
    topics: 1,
    concepts: plan.concepts.length,
    cards: plan.cards.length,
    quiz_history: plan.history.length,
    sessions: plan.session ? 1 : 0,
    mastery_snapshots: plan.snapshots.length,
  };
}

// Rows Postgres holds for one user (null when the schema isn't there yet).
export async function postgresCounts(pool, userId, topicId) {
  const { rows: [ok] } = await pool.query("SELECT to_regclass('concepts') IS NOT NULL AS ok");
  if (!ok.ok) return null;
  const { rows: [r] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE id = $1)::int AS users,
       (SELECT COUNT(*) FROM topics WHERE id = $2)::int AS topics,
       (SELECT COUNT(*) FROM concepts WHERE topic_id = $2)::int AS concepts,
       (SELECT COUNT(*) FROM cards WHERE user_id = $1)::int AS cards,
       (SELECT COUNT(*) FROM quiz_history WHERE user_id = $1)::int AS quiz_history,
       (SELECT COUNT(*) FROM sessions WHERE user_id = $1)::int AS sessions,
       (SELECT COUNT(*) FROM mastery_snapshots WHERE user_id = $1)::int AS mastery_snapshots`,
    [userId, topicId],
  );
  return r;
}

// jsonb parameters go in as JSON text: pg would turn a bare JS array into a Postgres array.
const json = (v) => (v == null ? null : JSON.stringify(v));

// Writes one user's plan in a single transaction. Idempotent: every table upserts on its
// natural key, and quiz history inserts an entry only as many times as Redis holds it.
// Never deletes: a row Postgres has and Redis doesn't is left for verify to report.
export async function writeUser(pool, userId, plan) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = plan.topicId;

    await client.query(
      `INSERT INTO users (id, settings) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET settings = COALESCE(EXCLUDED.settings, users.settings)`,
      [userId, json(plan.settings)],
    );
    await client.query(
      `INSERT INTO topics (id, owner_user_id, name) VALUES ($1, $2, 'Library') ON CONFLICT DO NOTHING`,
      [t, userId],
    );

    if (plan.concepts.length) {
      // Same columns postgresStore.insertConcept fills; position = library order.
      const rows = plan.concepts.map((c, position) => ({
        id: `${t}:${c.id}`, local_id: c.id, name: c.name ?? '', summary: c.summary ?? '',
        unit: c.scope?.module ?? null, lesson: c.scope?.lesson ?? null,
        tags: Array.isArray(c.tags) ? c.tags.map(String) : [], position, data: c,
      }));
      await client.query(
        `INSERT INTO concepts (id, topic_id, local_id, name, summary, unit, lesson, tags, provenance, position, data)
         SELECT r.id, $2, r.local_id, r.name, r.summary, r.unit, r.lesson,
                ARRAY(SELECT jsonb_array_elements_text(r.tags)),
                jsonb_build_object('addedBy', 'redis-migration', 'addedAt', now()), r.position, r.data
         FROM jsonb_to_recordset($1::jsonb) AS r(id text, local_id text, name text, summary text, unit text,
                                                 lesson text, tags jsonb, position int, data jsonb)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, summary = EXCLUDED.summary, unit = EXCLUDED.unit,
           lesson = EXCLUDED.lesson, tags = EXCLUDED.tags, position = EXCLUDED.position, data = EXCLUDED.data`,
        [json(rows), t],
      );
    }

    if (plan.cards.length) {
      const rows = plan.cards.map((c) => ({ concept_id: `${t}:${c.conceptId}`, state: c, due: c.nextReviewAt ?? null }));
      await client.query(
        `INSERT INTO cards (user_id, concept_id, state, due)
         SELECT $2, r.concept_id, r.state, r.due::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS r(concept_id text, state jsonb, due text)
         ON CONFLICT (user_id, concept_id) DO UPDATE SET state = EXCLUDED.state, due = EXCLUDED.due, updated_at = now()`,
        [json(rows), userId],
      );
    }

    if (plan.snapshots.length) {
      await client.query(
        `INSERT INTO mastery_snapshots (user_id, day, record)
         SELECT $2, r.day, r.record FROM jsonb_to_recordset($1::jsonb) AS r(day date, record jsonb)
         ON CONFLICT (user_id, day) DO UPDATE SET record = EXCLUDED.record`,
        [json(plan.snapshots), userId],
      );
    }

    if (plan.session) {
      const s = plan.session;
      // Session ids are UUIDs; the WHERE makes a clash with another user's row fail loudly
      // instead of overwriting it.
      const { rowCount } = await client.query(
        `INSERT INTO sessions (id, user_id, status, data, started_at, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data,
           started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, updated_at = clock_timestamp()
         WHERE sessions.user_id = EXCLUDED.user_id`,
        [s.sessionId, userId, s.status ?? null, json(s), s.startedAt ?? null, s.completedAt ?? null],
      );
      if (rowCount === 0) throw new Error(`session ${s.sessionId} already belongs to another user`);
    }

    if (plan.history.length) {
      // The n-th copy of an entry (oldest first) is inserted only if Postgres holds fewer
      // than n copies, so re-runs add nothing and genuine duplicates survive.
      const seen = new Map();
      const rows = plan.history.map((entry) => {
        const k = canonical(entry);
        seen.set(k, (seen.get(k) ?? 0) + 1);
        return { entry, occurrence: seen.get(k) };
      });
      for (const { entry, occurrence } of rows) {
        await client.query(
          `INSERT INTO quiz_history (user_id, quiz_id, completed_at, entry)
           SELECT $1, $2, $3, $4::jsonb
           WHERE (SELECT COUNT(*) FROM quiz_history WHERE user_id = $1 AND entry = $4::jsonb) < $5`,
          [userId, entry.quizId ?? null, entry.completedAt ?? null, json(entry), occurrence],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Compares what the app would read from each backend, through the store interface itself,
// plus raw row counts. Every value is compared, not a sample (the library is small).
// Returns a list of mismatches; empty means Postgres matches Redis for these users.
export async function verify({ redis, pool, userIds, primaryUserId }) {
  const redisStore = createRedisStore({ redis: readOnly(redis) });
  const pgStore = createPostgresStore({ pool, ephemeral: redisStore, migrateOnInit: false, primaryUserId });
  const { users } = await readRedis(redis, { userIds, primaryUserId });
  const mismatches = [];
  const check = (userId, what, a, b) => {
    if (!isDeepStrictEqual(a, b)) mismatches.push({ userId, what, redis: a, postgres: b });
  };

  for (const userId of userIds) {
    const plan = users[userId];
    const counts = await postgresCounts(pool, userId, plan.topicId);
    if (!counts) { mismatches.push({ userId, what: 'schema', redis: 'present', postgres: 'missing' }); continue; }
    const expected = planCounts(plan);
    for (const table of TABLES) check(userId, `count ${table}`, expected[table], counts[table]);

    check(userId, 'concepts', await redisStore.getConcepts(userId), await pgStore.getConcepts(userId));
    const ids = [...new Set([...plan.concepts.map((c) => c.id), ...plan.cards.map((c) => c.conceptId)])];
    check(userId, 'cards', await redisStore.getCards(userId, ids), await pgStore.getCards(userId, ids));
    const n = Math.max(plan.history.length, 1);
    check(userId, 'quiz history', await redisStore.getHistory(userId, n), await pgStore.getHistory(userId, n));
    check(userId, 'session', await redisStore.getSession(userId), await pgStore.getSession(userId));
    check(userId, 'settings', await redisStore.getSettings(userId), await pgStore.getSettings(userId));
    for (const { day } of plan.snapshots) {
      check(userId, `snapshot ${day}`, await redisStore.getMasterySnapshot(userId, day), await pgStore.getMasterySnapshot(userId, day));
    }
  }
  return mismatches;
}
