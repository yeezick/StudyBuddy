// The store interface spec (src/store/index.js). Each backend's test file calls this with a
// factory returning { store, cleanup }; every test gets a fresh, empty store.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const concept = (id, module = 'Module 1', extra = {}) => ({
  id,
  name: `Concept ${id}`,
  summary: `About ${id}`,
  scope: { course: 'Example Course', module, moduleLabel: `${module} label`, lesson: 'L1' },
  tags: ['t'],
  ...extra,
});

const card = (conceptId, nextReviewAt = '2026-10-05T12:00:00.000Z') => ({
  conceptId, score: 0.4, easeFactor: 2.36, interval: 6, repetitions: 2, nextReviewAt, lastReviewedAt: '2026-09-29T12:00:00.000Z',
});

// A card after T4: FSRS fields at the top level, SM-2 kept under `sm2`.
const fsrsCard = (conceptId) => ({
  conceptId, scheduler: 'fsrs', score: 0.45, nextReviewAt: '2026-10-20T12:00:00.000Z', lastReviewedAt: '2026-10-04T12:00:00.000Z',
  due: '2026-10-20T12:00:00.000Z', stability: 16.274931, difficulty: 7.2121, elapsed_days: 0, scheduled_days: 16,
  learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: '2026-10-04T12:00:00.000Z',
  sm2: { easeFactor: 2.5, interval: 15, repetitions: 3, nextReviewAt: '2026-10-19T12:00:00.000Z', lastReviewedAt: '2026-10-04T12:00:00.000Z' },
  convertedFromSm2At: '2026-10-04T12:00:00.000Z',
});

export function storeContract(name, makeStore) {
  let store;
  let cleanup;
  beforeEach(async () => { ({ store, cleanup } = await makeStore()); });
  afterEach(async () => { await cleanup?.(); });

  const t = (title, fn) => test(`[${name}] ${title}`, () => fn());

  t('concepts: empty library, then seeded once, in order, verbatim', async () => {
    assert.deepEqual(await store.getConcepts('u1'), []);
    const seed = [concept('c1'), concept('c2', 'Module 2', { mastery: { legacy: true } }), concept('c3')];
    assert.equal(await store.seedConcepts('u1', seed), true);
    assert.equal(await store.seedConcepts('u1', [concept('other')]), false, 'second seed is a no-op');
    assert.deepEqual(await store.getConcepts('u1'), seed);
  });

  t('concepts: add skips existing ids and appends in order', async () => {
    await store.seedConcepts('u1', [concept('c1'), concept('c2')]);
    const { added, total } = await store.addConcepts('u1', [concept('c2'), concept('c3'), concept('c4')]);
    assert.deepEqual(added.map((c) => c.id), ['c3', 'c4']);
    assert.equal(total, 4);
    assert.deepEqual((await store.getConcepts('u1')).map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
  });

  t('concepts: add creates the library when none exists, and blocks a later seed', async () => {
    const { total } = await store.addConcepts('u1', [concept('c1')]);
    assert.equal(total, 1);
    assert.equal(await store.seedConcepts('u1', [concept('c9')]), false);
  });

  t('concepts: update merges scope field by field and persists', async () => {
    await store.seedConcepts('u1', [concept('c1'), concept('c2')]);
    const updated = await store.updateConcept('u1', 'c1', { name: 'Renamed', scope: { lesson: 'L9' } });
    assert.equal(updated.name, 'Renamed');
    assert.deepEqual(updated.scope, { course: 'Example Course', module: 'Module 1', moduleLabel: 'Module 1 label', lesson: 'L9' });
    assert.deepEqual((await store.getConcepts('u1'))[0], updated);
    assert.equal((await store.getConcepts('u1'))[1].id, 'c2', 'order kept');
    assert.equal(await store.updateConcept('u1', 'missing', { name: 'x' }), null);
  });

  t('concepts: delete returns the remaining count, null when missing', async () => {
    await store.seedConcepts('u1', [concept('c1'), concept('c2'), concept('c3')]);
    assert.equal(await store.deleteConcept('u1', 'c2'), 2);
    assert.equal(await store.deleteConcept('u1', 'c2'), null);
    assert.deepEqual((await store.getConcepts('u1')).map((c) => c.id), ['c1', 'c3']);
  });

  t('concepts: libraries are per user', async () => {
    await store.seedConcepts('u1', [concept('c1')]);
    await store.seedConcepts('u2', [concept('c1', 'Module 7')]);
    await store.deleteConcept('u1', 'c1');
    assert.deepEqual(await store.getConcepts('u1'), []);
    assert.equal((await store.getConcepts('u2'))[0].scope.module, 'Module 7');
  });

  t('cards: missing → null, saved verbatim, overwritten, per user', async () => {
    assert.deepEqual(await store.getCards('u1', []), []);
    assert.deepEqual(await store.getCards('u1', ['c1', 'c2']), [null, null]);
    await store.saveCard('u1', card('c2'));
    assert.deepEqual(await store.getCards('u1', ['c1', 'c2']), [null, card('c2')]);
    const next = { ...card('c2', null), repetitions: 0 };
    await store.saveCard('u1', next);
    assert.deepEqual(await store.getCards('u1', ['c2']), [next]);
    assert.deepEqual(await store.getCards('u2', ['c2']), [null]);
  });

  t('cards: an FSRS card round-trips verbatim and replaces a flat SM-2 card', async () => {
    await store.saveCard('u1', card('c1'));
    await store.saveCard('u1', fsrsCard('c1'));
    assert.deepEqual(await store.getCards('u1', ['c1']), [fsrsCard('c1')]);
  });

  t('quizzes: save, load, delete; one active quiz pointer per user', async () => {
    const quiz = { quizId: 'q-1', userId: 'u1', status: 'in_progress', questions: [{ id: 'q1', isCorrect: null }] };
    assert.equal(await store.getQuiz('q-1'), null);
    await store.saveQuiz(quiz);
    assert.deepEqual(await store.getQuiz('q-1'), quiz);
    await store.deleteQuiz('q-1');
    assert.equal(await store.getQuiz('q-1'), null);

    assert.equal(await store.getActiveQuizId('u1'), null);
    await store.setActiveQuizId('u1', 'q-1');
    assert.equal(await store.getActiveQuizId('u1'), 'q-1');
    assert.equal(await store.getActiveQuizId('u2'), null);
    await store.clearActiveQuizId('u1');
    assert.equal(await store.getActiveQuizId('u1'), null);
  });

  t('history: newest first, limited', async () => {
    assert.deepEqual(await store.getHistory('u1', 5), []);
    for (let i = 1; i <= 4; i++) {
      await store.addHistory('u1', { quizId: `q${i}`, score: i * 10, conceptIds: ['c1'], completedAt: `2026-10-0${i}T10:00:00.000Z` });
    }
    const top = await store.getHistory('u1', 3);
    assert.deepEqual(top.map((e) => e.quizId), ['q4', 'q3', 'q2']);
    assert.deepEqual(top[0], { quizId: 'q4', score: 40, conceptIds: ['c1'], completedAt: '2026-10-04T10:00:00.000Z' });
    assert.deepEqual(await store.getHistory('u2', 3), []);
  });

  t('sessions: the latest saved session wins; updates replace it', async () => {
    assert.equal(await store.getSession('u1'), null);
    const s1 = { sessionId: 's1', topic: 'A', status: 'active', startedAt: '2026-10-03T10:00:00.000Z', completedAt: null, segments: [{ breaks: [] }] };
    await store.saveSession('u1', s1);
    assert.deepEqual(await store.getSession('u1'), s1);
    const s1done = { ...s1, status: 'completed', completedAt: '2026-10-03T11:30:00.000Z' };
    await store.saveSession('u1', s1done);
    assert.deepEqual(await store.getSession('u1'), s1done);
    const s2 = { ...s1, sessionId: 's2', topic: 'B' };
    await store.saveSession('u1', s2);
    assert.deepEqual(await store.getSession('u1'), s2);
    assert.equal(await store.getSession('u2'), null);
  });

  t('settings: null until saved', async () => {
    assert.equal(await store.getSettings('u1'), null);
    await store.saveSettings('u1', { pingEnabled: false, pingDaysOfWeek: [1, 3] });
    assert.deepEqual(await store.getSettings('u1'), { pingEnabled: false, pingDaysOfWeek: [1, 3] });
  });

  t('mastery snapshots: keyed by user and day', async () => {
    const record = { date: '2026-10-01', modules: [{ name: 'Module 1', avg: 0.5 }] };
    assert.equal(await store.getMasterySnapshot('u1', '2026-10-01'), null);
    await store.saveMasterySnapshot('u1', '2026-10-01', record);
    assert.deepEqual(await store.getMasterySnapshot('u1', '2026-10-01'), record);
    assert.equal(await store.getMasterySnapshot('u1', '2026-10-02'), null);
    assert.equal(await store.getMasterySnapshot('u2', '2026-10-01'), null);
  });

  t('review events: appended, newest first, limited', async () => {
    assert.deepEqual(await store.getReviewEvents('u1'), []);
    const base = { userId: 'u1', trigger: 'on_demand', quizId: 'q-1', itemType: 'mcq', latencyMs: 4200, grade: 3 };
    const first = await store.appendReviewEvent({ ...base, conceptId: 'c1', correct: true, confidence: 3, ts: '2026-10-03T10:00:00.000Z' });
    assert.equal(first.ts, '2026-10-03T10:00:00.000Z');
    const second = await store.appendReviewEvent({ ...base, conceptId: 'c2', correct: false, confidence: 1 });
    assert.ok(!Number.isNaN(Date.parse(second.ts)), 'ts defaults to now');

    const events = await store.getReviewEvents('u1');
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map(({ conceptId, correct, confidence, latencyMs, grade, trigger, quizId, itemType, userId }) =>
        ({ conceptId, correct, confidence, latencyMs, grade, trigger, quizId, itemType, userId })),
      [
        { ...base, conceptId: 'c2', correct: false, confidence: 1 },
        { ...base, conceptId: 'c1', correct: true, confidence: 3 },
      ],
    );
    assert.equal((await store.getReviewEvents('u1', { limit: 1 }))[0].conceptId, 'c2');
    assert.deepEqual(await store.getReviewEvents('u2'), []);
  });

  t('review events: optional fields round-trip; null confidence and latency are dropped', async () => {
    const full = {
      userId: 'u1', conceptId: 'c1', trigger: 'scheduled_ping', quizId: 'q-9', itemType: 'free_text',
      correct: false, score: 0.5, confidence: null, latencyMs: null, grade: 1, ts: '2026-10-03T09:00:00.000Z',
    };
    const appended = await store.appendReviewEvent(full);
    const [read] = await store.getReviewEvents('u1');
    assert.equal(typeof appended.topicId, 'string', 'append fills in the topic');
    assert.equal(read.topicId, appended.topicId);
    assert.deepEqual(
      { ...read, confidence: read.confidence ?? null, latencyMs: read.latencyMs ?? null },
      { ...full, topicId: appended.topicId },
    );
  });

  t('review events: prev and next FSRS state round-trip (DEC-054)', async () => {
    const { conceptId: _c, ...next } = fsrsCard('c1');
    const prevState = { ...next, reps: 2, stability: 6, due: '2026-10-08T09:00:00.000Z', last_review: '2026-10-02T09:00:00.000Z' };
    const nextState = { ...next, retrievability_at_review: 0.9573358 };
    await store.appendReviewEvent({
      userId: 'u1', conceptId: 'c1', itemType: 'mcq', correct: true, confidence: 2, grade: 3,
      ts: '2026-10-04T12:00:00.000Z', prevState, nextState,
    });
    const [read] = await store.getReviewEvents('u1');
    assert.deepEqual(read.prevState, prevState);
    assert.deepEqual(read.nextState, nextState);
  });

  t('review events: an explain-back round-trips with no grade and an unscheduled marker (DEC-058)', async () => {
    const nextState = { scheduled: false, prompt: 'why?', explanation: 'because it is', feedback: 'ok', idle_latency: false };
    await store.appendReviewEvent({
      userId: 'u1', conceptId: 'c1', trigger: 'on_demand', quizId: 'q-1', itemType: 'explain_back',
      correct: true, score: 0.75, confidence: null, latencyMs: 9000, grade: null, prevState: null, nextState,
      ts: '2026-10-04T12:00:00.000Z',
    });
    const [read] = await store.getReviewEvents('u1');
    assert.equal(read.itemType, 'explain_back');
    assert.equal(read.score, 0.75);
    assert.equal(read.grade ?? null, null);
    assert.equal(read.prevState ?? null, null);
    assert.deepEqual(read.nextState, nextState);
  });

  t('retest slots: claimed once per key, capped per user-day (DEC-058)', async () => {
    assert.equal(await store.claimRetest('u1', '2026-10-03', 'quiz-1:c1', 2), 'claimed');
    assert.equal(await store.claimRetest('u1', '2026-10-03', 'quiz-1:c1', 2), 'duplicate');
    assert.equal(await store.claimRetest('u1', '2026-10-03', 'quiz-1:c2', 2), 'claimed');
    assert.equal(await store.claimRetest('u1', '2026-10-03', 'quiz-2:c1', 2), 'over_cap');
    assert.equal(await store.claimRetest('u1', '2026-10-03', 'quiz-1:c2', 2), 'duplicate', 'a claimed key stays claimed at the cap');
    assert.equal(await store.claimRetest('u1', '2026-10-04', 'quiz-2:c1', 2), 'claimed', 'a new day');
    assert.equal(await store.claimRetest('u2', '2026-10-03', 'quiz-3:c1', 2), 'claimed', 'per user');
  });

  t('review events: filter by topic and since, then limit', async () => {
    const at = (h) => `2026-10-03T${String(h).padStart(2, '0')}:00:00.000Z`;
    const base = { userId: 'u1', itemType: 'mcq', correct: true, grade: 3 };
    await store.appendReviewEvent({ ...base, conceptId: 'c1', ts: at(8) });
    await store.appendReviewEvent({ ...base, conceptId: 'c2', ts: at(9), topicId: 'other' });
    await store.appendReviewEvent({ ...base, conceptId: 'c3', ts: at(10) });
    await store.appendReviewEvent({ ...base, conceptId: 'c4', ts: at(11), topicId: 'other' });
    const library = (await store.getReviewEvents('u1')).find((e) => e.conceptId === 'c1').topicId;
    assert.notEqual(library, 'other');

    const ids = (events) => events.map((e) => e.conceptId);
    assert.deepEqual(ids(await store.getReviewEvents('u1', { topicId: 'other' })), ['c4', 'c2']);
    assert.deepEqual(ids(await store.getReviewEvents('u1', { topicId: library })), ['c3', 'c1']);
    assert.deepEqual(ids(await store.getReviewEvents('u1', { since: at(9) })), ['c4', 'c3', 'c2'], 'since is inclusive');
    assert.deepEqual(ids(await store.getReviewEvents('u1', { topicId: 'other', since: at(10) })), ['c4']);
    assert.deepEqual(ids(await store.getReviewEvents('u1', { since: at(9), limit: 2 })), ['c4', 'c3']);
    assert.deepEqual(await store.getReviewEvents('u1', { topicId: 'nope' }), []);
  });
}
