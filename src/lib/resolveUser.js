import { ownerConfig } from './config.js';

// Slack puts the caller in a different place for commands, actions and events.
export function slackUserIdOf(body) {
  return body?.user_id ?? body?.user?.id ?? body?.event?.user ?? null;
}

// Maps a Slack payload (command, action or event body) or a bare Slack user id to the app user.
// Today one owner is configured: SLACK_USER_ID resolves to SINGLE_USER_ID, everyone else to null.
export function resolveUser(ctx, owner = ownerConfig()) {
  const slackUserId = typeof ctx === 'string' ? ctx : slackUserIdOf(ctx);
  if (!slackUserId || !owner.userId || slackUserId !== owner.slackUserId) return null;
  return { userId: owner.userId, slackUserId };
}

// Reverse lookup for work that starts without a Slack payload (scheduled jobs).
export function slackUserIdFor(userId, owner = ownerConfig()) {
  return userId && userId === owner.userId ? owner.slackUserId : null;
}

export function isKnownUser(userId, owner = ownerConfig()) {
  return Boolean(owner.userId) && userId === owner.userId;
}

// Users whose library is seeded and whose recurring jobs are registered at boot.
export function bootUserIds(owner = ownerConfig()) {
  return owner.userId ? [owner.userId] : [];
}
