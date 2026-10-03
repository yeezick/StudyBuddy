import { applyConceptUpdate } from '../mcp/conceptOps.js';
import { migrate } from './migrate.js';

// Until topics reach the app (design §10 slice 3), each user has one library, stored as a
// topic of its own. The app keeps seeing local concept ids ("m1-c01"); rows use the global
// {topicId}:{localId} form.
export const libraryTopicId = (userId) => `${userId}-library`;
const globalId = (topicId, localId) => `${topicId}:${localId}`;
const localIdOf = (topicId, id) => (id.startsWith(`${topicId}:`) ? id.slice(topicId.length + 1) : id);

// jsonb parameters go in as JSON text: pg would turn a bare JS array into a Postgres array.
const json = (value) => (value == null ? null : JSON.stringify(value));

function withoutNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
}

// Records in Postgres; quizzes and the active-quiz pointer are short-lived and stay in
// `ephemeral` (a Redis store), per DEC-047.
export function createPostgresStore({ pool, ephemeral, migrateOnInit = true }) {
  const knownUsers = new Set();

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function ensureUser(db, userId) {
    if (knownUsers.has(userId)) return;
    await db.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    if (db === pool) knownUsers.add(userId); // a transaction may still roll back
  }

  // Creates the user's library topic if needed; returns true when it was created now.
  async function ensureLibrary(db, userId) {
    await ensureUser(db, userId);
    const { rowCount } = await db.query(
      `INSERT INTO topics (id, owner_user_id, name) VALUES ($1, $2, 'Library') ON CONFLICT DO NOTHING`,
      [libraryTopicId(userId), userId],
    );
    return rowCount === 1;
  }

  // Serialises writers to one library so positions stay unique and ordered.
  async function lockLibrary(db, userId) {
    await db.query('SELECT 1 FROM topics WHERE id = $1 FOR UPDATE', [libraryTopicId(userId)]);
  }

  async function insertConcept(db, topicId, concept, position, addedBy) {
    const { rows } = await db.query(
      `INSERT INTO concepts (id, topic_id, local_id, name, summary, unit, lesson, tags, provenance, position, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING
       RETURNING data`,
      [
        globalId(topicId, concept.id), topicId, concept.id,
        concept.name ?? '', concept.summary ?? '',
        concept.scope?.module ?? null, concept.scope?.lesson ?? null,
        Array.isArray(concept.tags) ? concept.tags : [],
        json({ addedBy, addedAt: new Date().toISOString() }),
        position, json(concept),
      ],
    );
    return rows[0]?.data ?? null;
  }

  async function nextPosition(db, topicId) {
    const { rows } = await db.query('SELECT COALESCE(MAX(position) + 1, 0) AS next FROM concepts WHERE topic_id = $1', [topicId]);
    return rows[0].next;
  }

  async function getConcepts(userId) {
    const { rows } = await pool.query('SELECT data FROM concepts WHERE topic_id = $1 ORDER BY position', [libraryTopicId(userId)]);
    return rows.map((r) => r.data);
  }

  return {
    backend: 'postgres',

    async init() {
      if (migrateOnInit) await migrate(pool);
      await pool.query('SELECT 1');
    },

    close: () => pool.end(),

    getConcepts,

    async seedConcepts(userId, concepts) {
      return tx(async (db) => {
        if (!(await ensureLibrary(db, userId))) return false;
        const topicId = libraryTopicId(userId);
        for (const [i, concept] of concepts.entries()) {
          await insertConcept(db, topicId, concept, i, 'seed');
        }
        return true;
      });
    },

    async addConcepts(userId, concepts) {
      return tx(async (db) => {
        await ensureLibrary(db, userId);
        await lockLibrary(db, userId);
        const topicId = libraryTopicId(userId);
        let position = await nextPosition(db, topicId);
        const added = [];
        for (const concept of concepts) {
          const row = await insertConcept(db, topicId, concept, position, 'mcp');
          if (row) { added.push(row); position++; }
        }
        const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM concepts WHERE topic_id = $1', [topicId]);
        return { added, total: rows[0].n };
      });
    },

    async updateConcept(userId, conceptId, updates) {
      return tx(async (db) => {
        const id = globalId(libraryTopicId(userId), conceptId);
        const { rows } = await db.query('SELECT data FROM concepts WHERE id = $1 FOR UPDATE', [id]);
        if (rows.length === 0) return null;
        const next = applyConceptUpdate(rows[0].data, updates);
        await db.query(
          `UPDATE concepts SET name = $2, summary = $3, unit = $4, lesson = $5, tags = $6, data = $7 WHERE id = $1`,
          [id, next.name ?? '', next.summary ?? '', next.scope?.module ?? null, next.scope?.lesson ?? null,
            Array.isArray(next.tags) ? next.tags : [], json(next)],
        );
        return next;
      });
    },

    async deleteConcept(userId, conceptId) {
      return tx(async (db) => {
        const topicId = libraryTopicId(userId);
        const { rowCount } = await db.query('DELETE FROM concepts WHERE id = $1', [globalId(topicId, conceptId)]);
        if (rowCount === 0) return null;
        const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM concepts WHERE topic_id = $1', [topicId]);
        return rows[0].n;
      });
    },

    async getCards(userId, conceptIds) {
      if (conceptIds.length === 0) return [];
      const topicId = libraryTopicId(userId);
      const { rows } = await pool.query(
        'SELECT concept_id, state FROM cards WHERE user_id = $1 AND concept_id = ANY($2)',
        [userId, conceptIds.map((id) => globalId(topicId, id))],
      );
      const byId = new Map(rows.map((r) => [r.concept_id, r.state]));
      return conceptIds.map((id) => byId.get(globalId(topicId, id)) ?? null);
    },

    async saveCard(userId, card) {
      await ensureUser(pool, userId);
      await pool.query(
        `INSERT INTO cards (user_id, concept_id, state, due) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, concept_id) DO UPDATE SET state = EXCLUDED.state, due = EXCLUDED.due, updated_at = now()`,
        [userId, globalId(libraryTopicId(userId), card.conceptId), json(card), card.nextReviewAt ?? null],
      );
    },

    getQuiz: ephemeral.getQuiz,
    saveQuiz: ephemeral.saveQuiz,
    deleteQuiz: ephemeral.deleteQuiz,
    getActiveQuizId: ephemeral.getActiveQuizId,
    setActiveQuizId: ephemeral.setActiveQuizId,
    clearActiveQuizId: ephemeral.clearActiveQuizId,

    async addHistory(userId, entry) {
      await ensureUser(pool, userId);
      await pool.query(
        'INSERT INTO quiz_history (user_id, quiz_id, completed_at, entry) VALUES ($1, $2, $3, $4)',
        [userId, entry.quizId ?? null, entry.completedAt ?? null, json(entry)],
      );
    },

    async getHistory(userId, limit) {
      const { rows } = await pool.query(
        'SELECT entry FROM quiz_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
        [userId, limit],
      );
      return rows.map((r) => r.entry);
    },

    async getSession(userId) {
      const { rows } = await pool.query(
        'SELECT data FROM sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [userId],
      );
      return rows[0]?.data ?? null;
    },

    async saveSession(userId, session) {
      await ensureUser(pool, userId);
      await pool.query(
        `INSERT INTO sessions (id, user_id, status, data, started_at, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data,
           started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, updated_at = clock_timestamp()`,
        [session.sessionId, userId, session.status ?? null, json(session), session.startedAt ?? null, session.completedAt ?? null],
      );
    },

    async getSettings(userId) {
      const { rows } = await pool.query('SELECT settings FROM users WHERE id = $1', [userId]);
      return rows[0]?.settings ?? null;
    },

    async saveSettings(userId, settings) {
      await pool.query(
        'INSERT INTO users (id, settings) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings',
        [userId, json(settings)],
      );
      knownUsers.add(userId);
    },

    async getMasterySnapshot(userId, day) {
      const { rows } = await pool.query('SELECT record FROM mastery_snapshots WHERE user_id = $1 AND day = $2', [userId, day]);
      return rows[0]?.record ?? null;
    },

    async saveMasterySnapshot(userId, day, record) {
      await ensureUser(pool, userId);
      await pool.query(
        `INSERT INTO mastery_snapshots (user_id, day, record) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, day) DO UPDATE SET record = EXCLUDED.record`,
        [userId, day, json(record)],
      );
    },

    async appendReviewEvent(event) {
      await ensureUser(pool, event.userId);
      const topicId = event.topicId ?? libraryTopicId(event.userId);
      const { rows } = await pool.query(
        `INSERT INTO review_events (user_id, concept_id, topic_id, ts, trigger, quiz_id, item_type, correct, score,
           confidence, latency_ms, grade, prev_state, next_state)
         VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING ts`,
        [event.userId, globalId(topicId, event.conceptId), topicId, event.ts ?? null, event.trigger ?? null,
          event.quizId ?? null, event.itemType ?? null, event.correct ?? null, event.score ?? null,
          event.confidence ?? null, event.latencyMs ?? null, event.grade ?? null,
          json(event.prevState), json(event.nextState)],
      );
      return { ...event, ts: rows[0].ts.toISOString() };
    },

    async getReviewEvents(userId, { limit = 100 } = {}) {
      const { rows } = await pool.query(
        'SELECT * FROM review_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
        [userId, limit],
      );
      return rows.map((r) => withoutNulls({
        userId: r.user_id,
        conceptId: localIdOf(r.topic_id, r.concept_id),
        topicId: r.topic_id,
        ts: r.ts.toISOString(),
        trigger: r.trigger,
        quizId: r.quiz_id,
        itemType: r.item_type,
        correct: r.correct,
        score: r.score,
        confidence: r.confidence,
        latencyMs: r.latency_ms,
        grade: r.grade,
        prevState: r.prev_state,
        nextState: r.next_state,
      }));
    },
  };
}
