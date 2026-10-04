import pg from 'pg';
import { redis } from '../redis.js';
import { createRedisStore } from './redisStore.js';
import { createPostgresStore } from './postgresStore.js';
import { ownerConfig } from '../lib/config.js';

// The store interface — every handler reads and writes app data through it.
// Both backends implement all of it; test/helpers/storeContract.js is the spec.
//
//   init(), close()
//   getConcepts(userId) → Concept[] in library order
//   seedConcepts(userId, concepts) → true if written, false if the library already exists
//   addConcepts(userId, concepts) → { added, total }   (ids already present are skipped)
//   updateConcept(userId, conceptId, updates) → Concept | null
//   deleteConcept(userId, conceptId) → remaining count | null
//   getCards(userId, conceptIds) → (card | null)[]      saveCard(userId, card)
//   getQuiz(quizId), saveQuiz(quiz), deleteQuiz(quizId)
//   getActiveQuizId(userId), setActiveQuizId(userId, quizId), clearActiveQuizId(userId)
//   claimRetest(userId, day, key, cap) → 'claimed' | 'duplicate' | 'over_cap'
//   addHistory(userId, entry), getHistory(userId, limit, { excludeTriggers }) → newest first
//   getSession(userId) → latest saved session | null    saveSession(userId, session)
//   getSettings(userId) → object | null                 saveSettings(userId, settings)
//   getMasterySnapshot(userId, day), saveMasterySnapshot(userId, day, record)
//   appendReviewEvent(event) → event with topicId and ts filled in (append-only)
//   getReviewEvents(userId, { topicId, since, limit }) → newest first
//
// STORE_BACKEND: `redis` (default, today's keys) or `postgres` (needs DATABASE_URL or PG* vars).
// Quizzes and retest slots stay in Redis under both backends (short-lived state, DEC-047).
export function createStoreFromEnv(env = process.env, { redisClient = redis } = {}) {
  const backend = env.STORE_BACKEND || 'redis';
  const redisStore = createRedisStore({ redis: redisClient, primaryUserId: ownerConfig(env).userId });
  if (backend === 'redis') return redisStore;
  if (backend === 'postgres') {
    // DATABASE_URL, or the standard libpq PG* variables (PGHOST, PGDATABASE, …) that node-postgres reads itself.
    if (!env.DATABASE_URL && !env.PGHOST) throw new Error('STORE_BACKEND=postgres needs DATABASE_URL (or PGHOST/PGDATABASE).');
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL || undefined, max: 5 });
    // Hosted Postgres drops idle connections; without a listener that crashes the process.
    pool.on('error', (err) => console.error(`[store:postgres] idle client error | ${err.message}`));
    return createPostgresStore({ pool, ephemeral: redisStore, primaryUserId: ownerConfig(env).userId });
  }
  throw new Error(`Unknown STORE_BACKEND "${backend}". Use "redis" or "postgres".`);
}

export const store = createStoreFromEnv();
