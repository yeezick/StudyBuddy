import './lib/env.js';
import express from 'express';
import { redis } from './redis.js';
import { seedIfEmpty } from './lib/concepts.js';
import { assertMcpAuthConfigured, requireBearer } from './lib/auth.js';
import { depSnapshot, track, withTimeout } from './lib/health.js';
import { boltApp } from './slack/app.js';
import { registerCommands } from './slack/commands.js';
import { registerQuizHandlers } from './slack/quizFlow.js';
import {
  handleSessionSynth,
  handleSessionRecall,
  handleBreakEnd,
  handleSessionEnd,
  handleSessionWrapMorning,
  registerSessionHandlers,
} from './slack/sessionFlow.js';
import { registerMessageRouter } from './slack/messageRouter.js';
import { startScheduler } from './scheduler/jobs.js';
import { mountMcp } from './mcp/server.js';

const HEALTH_REDIS_TIMEOUT_MS = 500;

const app = express();
const port = process.env.PORT || 3000;
const userId = process.env.SINGLE_USER_ID;

if (!userId) {
  throw new Error('Missing SINGLE_USER_ID. Set it in .env');
}
assertMcpAuthConfigured();

// Always 200 while the process is up; each dependency reports its own state.
app.get('/health', async (req, res) => {
  let redisState;
  try {
    const pong = await withTimeout(redis.ping(), HEALTH_REDIS_TIMEOUT_MS, 'redis ping');
    redisState = { state: pong === 'PONG' ? 'ok' : 'unexpected' };
  } catch (err) {
    redisState = { state: 'error', detail: err.message };
  }
  res.status(200).json({
    status: 'ok',
    deps: { redis: redisState, ...depSnapshot() },
    timestamp: new Date().toISOString(),
  });
});

mountMcp(app, requireBearer());
registerCommands();
registerQuizHandlers();
registerSessionHandlers();
registerMessageRouter();

// Slack and BullMQ connect after the port is bound, so /health answers even if they are slow or down.
async function startServices() {
  await Promise.all([
    track('seed', () => seedIfEmpty(userId)),
    track('slack', async () => {
      await boltApp.init();
      await boltApp.start();
    }),
    track('scheduler', () => startScheduler(boltApp.client, userId, {
      synth:       (job) => handleSessionSynth(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
      recall:      (job) => handleSessionRecall(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
      sessionEnd:  (job) => handleSessionEnd(boltApp.client, job.data.userId, job.data.sessionId),
      breakEnd:    (job) => handleBreakEnd(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
      wrapMorning: (job) => handleSessionWrapMorning(boltApp.client, job.data.userId, job.data.sessionId),
    })),
  ]);
  console.log(`[boot] background start finished | ${JSON.stringify(depSnapshot())}`);
}

app.listen(port, () => {
  console.log(`StudyAgent listening on port ${port}`);
  startServices();
});
