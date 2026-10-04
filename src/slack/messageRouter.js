import { boltApp } from './app.js';
import { pendingQuizReply } from './quizFlow.js';
import { pendingExplainBack } from './explainBack.js';
import { pendingSessionReply, isBreakMessage, handleBreakDetection } from './sessionFlow.js';

// One message listener for the whole app, so each DM is consumed exactly once.
// A pending quiz answer wins over a pending explain-back, then a pending session prompt, then
// break detection — a free-text answer like "I'd pause the job for 10 min" is an answer, not a
// break request.
export function routeMessage(message, { hasQuizReply, hasExplainReply = () => false, hasSessionReply }) {
  if (message.subtype) return 'ignore';
  if (hasQuizReply(message.user, message.channel)) return 'quiz';
  if (hasExplainReply(message.user, message.channel)) return 'explain';
  if (hasSessionReply(message.user, message.channel)) return 'session';
  if (isBreakMessage(message.text)) return 'break';
  return 'ignore';
}

export function registerMessageRouter() {
  boltApp.message(async ({ message, client, context }) => {
    const text = message.text ?? '';
    const quizReply = pendingQuizReply(message.user, message.channel);
    const explainReply = pendingExplainBack(message.user, message.channel);
    const sessionReply = pendingSessionReply(message.user, message.channel);
    const route = routeMessage(message, {
      hasQuizReply: () => Boolean(quizReply),
      hasExplainReply: () => Boolean(explainReply),
      hasSessionReply: () => Boolean(sessionReply),
    });

    if (route === 'quiz') await quizReply(text);
    else if (route === 'explain') await explainReply(text, client);
    else if (route === 'session') await sessionReply(text);
    else if (route === 'break') await handleBreakDetection(client, context.userId, message.channel, text);
  });
}
