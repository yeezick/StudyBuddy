// The only module that reads the owner env vars. Everything else gets its user from
// resolveUser.js, so moving to a users table later changes this file and that one only.
export function ownerConfig(env = process.env) {
  return {
    userId: env.SINGLE_USER_ID || null,
    slackUserId: env.SLACK_USER_ID || null,
  };
}

export function assertOwnerConfigured(env = process.env) {
  if (!env.SINGLE_USER_ID) throw new Error('Missing SINGLE_USER_ID. Set it in .env');
  if (!env.SLACK_USER_ID) throw new Error('Missing SLACK_USER_ID. Set it in .env');
}
