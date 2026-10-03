import './lib/env.js';
import express from 'express';
import { redis } from './redis.js';
import { seedIfEmpty } from './lib/concepts.js';
import { store } from './store/index.js';
import { assertMcpAuthConfigured, requireBearer } from './lib/auth.js';
import { assertOwnerConfigured } from './lib/config.js';
import { bootUserIds } from './lib/resolveUser.js';
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

assertOwnerConfigured();
assertMcpAuthConfigured();
const userIds = bootUserIds();

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
    storeBackend: store.backend,
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
// Seeding and the scheduler wait for the store (Postgres runs its migrations in init).
async function startServices() {
  const storeReady = track('store', () => store.init());
  await Promise.all([
    storeReady.then(() => track('seed', () => Promise.all(userIds.map((id) => seedIfEmpty(id))))),
    track('slack', async () => {
      await boltApp.init();
      await boltApp.start();
    }),
    storeReady.then(() => track('scheduler', () => startScheduler(boltApp.client, userIds, {
      synth:       (job) => handleSessionSynth(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
      recall:      (job) => handleSessionRecall(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
      sessionEnd:  (job) => handleSessionEnd(boltApp.client, job.data.userId, job.data.sessionId),
      breakEnd:    (job) => handleBreakEnd(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
      wrapMorning: (job) => handleSessionWrapMorning(boltApp.client, job.data.userId, job.data.sessionId),
    }))),
  ]);
  console.log(`[boot] background start finished | ${JSON.stringify(depSnapshot())}`);
}

app.listen(port, () => {
  console.log(`StudyAgent listening on port ${port}`);
  startServices();
});
