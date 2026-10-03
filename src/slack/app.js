import pkg from '@slack/bolt';
import { allowOnlyOwner } from './allowlist.js';
const { App } = pkg;

const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'SLACK_USER_ID'];
for (const k of required) {
  if (!process.env[k]) {
    throw new Error(`Missing ${k}. Set it in .env`);
  }
}

export function createBoltApp(options) {
  const app = new App(options);
  app.use(allowOnlyOwner);
  return app;
}

// deferInitialization: Bolt v4 otherwise calls auth.test in the constructor, at import time,
// before /health is bound. index.js runs boltApp.init() + start() in the background instead.
export const boltApp = createBoltApp({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  deferInitialization: true,
});
