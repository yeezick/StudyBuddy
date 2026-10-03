// Single-user bot: every Slack request from anyone but SLACK_USER_ID is dropped.
// Registered once as Bolt global middleware, so it covers every command, action and message.

export function slackUserIdOf(body) {
  return body?.user_id ?? body?.user?.id ?? body?.event?.user ?? null;
}

export function isAllowedSlackUser(userId, allowed = process.env.SLACK_USER_ID) {
  return Boolean(allowed) && userId === allowed;
}

export async function allowOnlyOwner({ body, ack, next }) {
  const userId = slackUserIdOf(body);
  if (isAllowedSlackUser(userId)) {
    await next();
    return;
  }
  // Ack commands/actions so the caller gets no timeout error; events have no ack here.
  if (typeof ack === 'function') await ack();
  if (!body?.event?.bot_id) {
    console.warn(`[slack:allowlist] dropped request | user=${userId ?? 'unknown'} | type=${body?.command ?? body?.type ?? 'unknown'}`);
  }
}
