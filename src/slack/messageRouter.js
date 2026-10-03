import { boltApp } from './app.js';
import { pendingQuizReply } from './quizFlow.js';
import { pendingSessionReply, isBreakMessage, handleBreakDetection } from './sessionFlow.js';

// One message listener for the whole app, so each DM is consumed exactly once.
// A pending quiz answer wins over a pending session prompt, which wins over break detection —
// a free-text answer like "I'd pause the job for 10 min" is an answer, not a break request.
export function routeMessage(message, { hasQuizReply, hasSessionReply }) {
  if (message.subtype) return 'ignore';
  if (hasQuizReply(message.user, message.channel)) return 'quiz';
  if (hasSessionReply(message.user, message.channel)) return 'session';
  if (isBreakMessage(message.text)) return 'break';
  return 'ignore';
}

export function registerMessageRouter() {
  const userId = process.env.SINGLE_USER_ID;

  boltApp.message(async ({ message, client }) => {
    const text = message.text ?? '';
    const quizReply = pendingQuizReply(message.user, message.channel);
    const sessionReply = pendingSessionReply(message.user, message.channel);
    const route = routeMessage(message, {
      hasQuizReply: () => Boolean(quizReply),
      hasSessionReply: () => Boolean(sessionReply),
    });

    if (route === 'quiz') await quizReply(text);
    else if (route === 'session') await sessionReply(text);
    else if (route === 'break') await handleBreakDetection(client, userId, message.channel, text);
  });
}
