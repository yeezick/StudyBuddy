import pkg from '@slack/bolt';
const { App } = pkg;

const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
for (const k of required) {
  if (!process.env[k]) {
    throw new Error(`Missing ${k}. Set it in .env`);
  }
}

export const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});
