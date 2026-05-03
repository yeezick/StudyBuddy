import '../src/lib/env.js';
import { boltApp } from '../src/slack/app.js';
import { getDMChannel } from '../src/slack/dm.js';

const userId = process.env.SLACK_USER_ID;
if (!userId) {
  console.error('Missing SLACK_USER_ID in .env');
  process.exit(1);
}

async function main() {
  await boltApp.start();
  console.log('⚡️ Bolt connected');

  const channelId = await getDMChannel(boltApp.client, userId);
  console.log(`DM channel for ${userId}: ${channelId}`);

  await boltApp.client.chat.postMessage({
    channel: channelId,
    text: '✅ DM channel resolution OK — Step 5 smoke test',
  });
  console.log('Message sent. Check your Slack DMs.');

  await boltApp.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('test-dm failed:', err);
  process.exit(1);
});
