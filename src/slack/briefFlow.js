import { getConcepts } from '../lib/concepts.js';
import { getAllMastery } from '../lib/mastery.js';
import { redis } from '../redis.js';

function parse(raw) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function daysFromNow(isoString) {
  return Math.round((new Date(isoString) - Date.now()) / 86400000);
}

function reviewLabel(days) {
  if (days <= 0) return 'due today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function timeAgoLabel(isoString) {
  const days = Math.round((Date.now() - new Date(isoString)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

async function getNextReview(userId) {
  const concepts = await getConcepts(userId);
  if (concepts.length === 0) return null;

  const masteryObjects = await getAllMastery(userId, concepts.map((c) => c.id));

  const withDates = concepts
    .map((c, i) => ({ concept: c, mastery: masteryObjects[i] }))
    .filter(({ mastery }) => mastery.nextReviewAt)
    .sort((a, b) => new Date(a.mastery.nextReviewAt) - new Date(b.mastery.nextReviewAt));

  if (withDates.length === 0) return null;
  return { concept: withDates[0].concept, date: withDates[0].mastery.nextReviewAt };
}

export async function buildBriefSnapshot(userId) {
  const [sessionRaw, historyRaw] = await Promise.all([
    redis.get(`session:${userId}`),
    redis.lrange(`history:${userId}`, 0, 0),
  ]);

  const session = parse(sessionRaw);
  const lastQuiz = historyRaw?.[0] ? parse(historyRaw[0]) : null;
  const nextReview = await getNextReview(userId);

  return { session, lastQuiz, nextReview };
}

export function formatBriefBlocks({ session, lastQuiz, nextReview }) {
  // Session line
  let sessionText;
  if (session?.status === 'active') {
    const elapsed = Math.round(
      (Date.now() - new Date(session.currentSegmentStart).getTime()) / 60000
    );
    sessionText = `*Session:* Active \u2014 ${session.topic} \u00b7 Segment ${session.currentSegmentIndex + 1} \u00b7 ${elapsed} min elapsed`;
  } else if (session?.status === 'on_break') {
    sessionText = `*Session:* On break \u2014 ${session.topic}`;
  } else {
    sessionText = `*Session:* No active session`;
  }

  // Next review line
  let nextReviewText;
  if (nextReview) {
    nextReviewText = `*Next review:* ${nextReview.concept.name} \u2014 ${reviewLabel(daysFromNow(nextReview.date))}`;
  } else {
    nextReviewText = `*Next review:* No reviews scheduled`;
  }

  // Last quiz line
  let lastQuizText;
  if (lastQuiz) {
    const scopeLabel = lastQuiz.scope?.module ?? lastQuiz.scope?.lesson ?? 'all concepts';
    lastQuizText = `*Last quiz:* ${lastQuiz.score}/100 \u00b7 ${scopeLabel} \u00b7 ${timeAgoLabel(lastQuiz.completedAt)}`;
  } else {
    lastQuizText = `*Last quiz:* No quizzes taken yet`;
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '\ud83d\udccb *Brief*' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [sessionText, nextReviewText, lastQuizText].join('\n'),
      },
    },
  ];
}

export async function postBrief(client, userId, channelId) {
  const snapshot = await buildBriefSnapshot(userId);
  await client.chat.postMessage({
    channel: channelId,
    blocks: formatBriefBlocks(snapshot),
    text: '\ud83d\udccb Brief',
  });
}
