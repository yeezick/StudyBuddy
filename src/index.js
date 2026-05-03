import './lib/env.js';
import express from 'express';
import { redis } from './redis.js';
import { seedIfEmpty } from './lib/concepts.js';
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
import { startScheduler } from './scheduler/jobs.js';

const app = express();
const port = process.env.PORT || 3000;
const userId = process.env.SINGLE_USER_ID;

if (!userId) {
  throw new Error('Missing SINGLE_USER_ID. Set it in .env');
}

app.get('/health', async (req, res) => {
  try {
    const pong = await redis.ping();
    res.status(200).json({
      status: 'ok',
      redis: pong === 'PONG' ? 'connected' : 'unexpected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      redis: 'disconnected',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

async function start() {
  await seedIfEmpty(userId);
  registerCommands();
  registerQuizHandlers();
  registerSessionHandlers();
  await boltApp.start();
  await startScheduler(boltApp.client, userId, {
    synth:       (job) => handleSessionSynth(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
    recall:      (job) => handleSessionRecall(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
    sessionEnd:  (job) => handleSessionEnd(boltApp.client, job.data.userId, job.data.sessionId),
    breakEnd:    (job) => handleBreakEnd(boltApp.client, job.data.userId, job.data.sessionId, job.data.segmentIndex),
    wrapMorning: (job) => handleSessionWrapMorning(boltApp.client, job.data.userId, job.data.sessionId),
  });
  console.log('⚡️ Bolt connected (Socket Mode)');
  app.listen(port, () => {
    console.log(`StudyAgent listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
