import { resolveUser, slackUserIdOf } from '../lib/resolveUser.js';

export { slackUserIdOf };

// Events Slack sends about messages nobody typed to the bot: the bot's own posts, edits,
// deletions and other subtypes, or events with no user. Dropped before the allow-list, quietly.
export function isNoiseEvent(body) {
  const event = body?.event;
  if (!event) return false;
  return Boolean(event.bot_id || event.subtype || !event.user);
}

const warnedUsers = new Set();

// Every Slack request is resolved to an app user once, here. Unknown callers are dropped;
// known ones reach handlers with `context.userId` set. Registered as Bolt global middleware,
// so it covers every command, action and message.
export async function allowOnlyOwner({ body, context, ack, next }) {
  if (isNoiseEvent(body)) return;
  const user = resolveUser(body);
  if (user) {
    if (context) context.userId = user.userId;
    await next();
    return;
  }
  // Ack commands/actions so the caller gets no timeout error; events have no ack here.
  if (typeof ack === 'function') await ack();
  // A real stranger is worth one line, not one per message.
  const who = slackUserIdOf(body) ?? 'unknown';
  if (warnedUsers.has(who)) return;
  warnedUsers.add(who);
  console.warn(`[slack:allowlist] dropped request | user=${who} | type=${body?.command ?? body?.type ?? 'unknown'} | further drops for this user are not logged`);
}
