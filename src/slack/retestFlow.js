import { store } from '../store/index.js';
import { getConcepts } from '../lib/concepts.js';
import { addJobOnce } from '../scheduler/jobs.js';
import { RETEST_DELAY_MS, RETEST_TRIGGER, retestItemType } from '../lib/retest.js';
import { startQuiz, onQuizEnd } from './quizFlow.js';

// Confident-miss retest (DEC-058 §1): queued when a quiz ends, sent ~10 min later as a
// one-question quiz on the same concept with trigger `retest`.

// A retest that finds another quiz in progress waits this long, at most this many times.
export const RETEST_BUSY_DELAY_MS = 10 * 60 * 1000;
export const RETEST_MAX_DEFERS = 3;

// BullMQ job ids may not contain ':'.
export const retestJobId = (quizId, conceptId, defers = 0) =>
  `retest__${quizId}__${conceptId}${defers ? `__d${defers}` : ''}`;

// One job per quiz × concept, whether the quiz completed or was cancelled. The fixed job id
// makes a second enqueue for the same pair a no-op.
export async function enqueueRetests(quiz, { addJob = addJobOnce } = {}) {
  const seen = new Set();
  for (const q of quiz.questions) {
    if (!q.retestQueued || seen.has(q.conceptId)) continue;
    seen.add(q.conceptId);
    await addJob('retest', {
      userId: quiz.userId,
      slackUserId: quiz.slackUserId,
      channelId: quiz.slackChannelId,
      quizId: quiz.quizId,
      conceptId: q.conceptId,
      previousPrompt: q.prompt,
      defers: 0,
    }, { jobId: retestJobId(quiz.quizId, q.conceptId), delay: RETEST_DELAY_MS });
  }
}

const introText = (name) =>
  `\u{1F501} *Quick re-check.* Earlier you were sure about *${name}* but missed it. One new question on it:`;

export async function handleRetestJob(client, data, { addJob = addJobOnce } = {}) {
  const { userId, slackUserId, channelId, quizId, conceptId, previousPrompt, defers = 0 } = data;

  const activeId = await store.getActiveQuizId(userId);
  const active = activeId ? await store.getQuiz(activeId) : null;
  if (active?.status === 'in_progress') {
    if (defers >= RETEST_MAX_DEFERS) {
      console.warn(`[retest] dropped: a quiz stayed in progress | userId=${userId} | quizId=${quizId} | concept=${conceptId}`);
      return;
    }
    await addJob('retest', { ...data, defers: defers + 1 },
      { jobId: retestJobId(quizId, conceptId, defers + 1), delay: RETEST_BUSY_DELAY_MS });
    return;
  }

  const concept = (await getConcepts(userId)).find((c) => c.id === conceptId);
  if (!concept) {
    console.warn(`[retest] dropped: concept no longer exists | userId=${userId} | concept=${conceptId}`);
    return;
  }
  const [card] = await store.getCards(userId, [conceptId]);
  const type = retestItemType(card);

  await client.chat.postMessage({ channel: channelId, text: introText(concept.name) });
  try {
    await startQuiz(client, userId, slackUserId, channelId, {
      mode: 'retest',
      freeFormPrompt: previousPrompt ? `Ask something different from this earlier question: "${previousPrompt}"` : null,
    }, {
      trigger: RETEST_TRIGGER,
      concepts: [concept],
      count: 1,
      distribution: { [type]: 1 },
    });
  } catch (err) {
    console.error(`[retest] could not start | userId=${userId} | concept=${conceptId} | ${err.message}`);
    await client.chat.postMessage({ channel: channelId, text: "Couldn't build the re-check question this time \u2014 it stays in your reviews." });
  }
}

export function registerRetestFlow() {
  onQuizEnd((quiz) => enqueueRetests(quiz));
}
