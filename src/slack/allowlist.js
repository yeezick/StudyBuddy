import { resolveUser, slackUserIdOf } from '../lib/resolveUser.js';

export { slackUserIdOf };

// Every Slack request is resolved to an app user once, here. Unknown callers are dropped;
// known ones reach handlers with `context.userId` set. Registered as Bolt global middleware,
// so it covers every command, action and message.
export async function allowOnlyOwner({ body, context, ack, next }) {
  const user = resolveUser(body);
  if (user) {
    if (context) context.userId = user.userId;
    await next();
    return;
  }
  // Ack commands/actions so the caller gets no timeout error; events have no ack here.
  if (typeof ack === 'function') await ack();
  if (!body?.event?.bot_id) {
    console.warn(`[slack:allowlist] dropped request | user=${slackUserIdOf(body) ?? 'unknown'} | type=${body?.command ?? body?.type ?? 'unknown'}`);
  }
}
