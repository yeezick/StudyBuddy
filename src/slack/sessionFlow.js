import crypto from 'node:crypto';
import { redis } from '../redis.js';
import { boltApp } from './app.js';
import { getConcepts } from '../lib/concepts.js';
import { startQuiz, registerQuizCompletion } from './quizFlow.js';
import { scheduleJob, removeJob } from '../scheduler/jobs.js';

const SEGMENT_MINUTES = 45;
const SYNTH_WARNING_MINUTES = 40;
const BREAK_PATTERNS = [/\bbreak\b/i, /\bstepping away\b/i, /\bbrb\b/i, /\bpause\b/i];
const DURATION_PATTERN = /\b(\d+)\s*(min|minute)s?\b/i;

const pendingReplies = new Map();

// ── Pure helpers (exported for testing) ──────────────────────────────────────

export function parseDuration(str) {
  if (!str) return 90;
  const m = str.match(/^(\d+)\s*m$/i);
  if (m) return parseInt(m[1]);
  const h = str.match(/^(\d+)\s*h$/i);
  if (h) return parseInt(h[1]) * 60;
  return 90;
}

export function isBreakMessage(text) {
  if (!text) return false;
  for (const pat of BREAK_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return DURATION_PATTERN.test(text);
}

export function parseBreakDuration(text, defaultMinutes) {
  const match = text.match(DURATION_PATTERN);
  return match ? parseInt(match[1]) : defaultMinutes;
}

export function formatSessionPlan(session) {
  const { topic, plannedDuration, segmentDuration, breakDuration } = session;
  const numSegments = Math.ceil(plannedDuration / segmentDuration);
  const lines = [`📚 *Session Plan — ${topic}* (${plannedDuration} min)\n`];
  let cursor = 0;
  for (let i = 0; i < numSegments; i++) {
    const end = Math.min(cursor + segmentDuration, plannedDuration);
    lines.push(`• Segment ${i + 1}: ${cursor}–${end} min`);
    cursor = end + breakDuration;
  }
  lines.push(`\nI'll send a synthesis cue at 40 min and an active recall prompt at 45 min.`);
  return lines.join('\n');
}

// ── Redis helpers ─────────────────────────────────────────────────────────────

function sessionKey(userId) { return `session:${userId}`; }

async function loadSession(userId) {
  const raw = await redis.get(sessionKey(userId));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveSession(userId, session) {
  await redis.set(sessionKey(userId), JSON.stringify(session));
}

// ── BullMQ job helpers ────────────────────────────────────────────────────────

async function scheduleSegmentJobs(userId, session) {
  const { sessionId, currentSegmentIndex: n, currentSegmentElapsed: elapsed } = session;
  const synthDelay = Math.max(5000, (SYNTH_WARNING_MINUTES * 60 - elapsed) * 1000);
  const recallDelay = Math.max(5000, (SEGMENT_MINUTES * 60 - elapsed) * 1000);

  await scheduleJob('session-synth', { userId, sessionId, segmentIndex: n }, {
    jobId: `session-synth__${sessionId}__${n}`,
    delay: synthDelay,
  });
  await scheduleJob('session-recall', { userId, sessionId, segmentIndex: n }, {
    jobId: `session-recall__${sessionId}__${n}`,
    delay: recallDelay,
  });
}

async function scheduleSessionEndJob(userId, session) {
  const { sessionId, plannedDuration, startedAt } = session;
  const endAt = new Date(new Date(startedAt).getTime() + plannedDuration * 60 * 1000);
  const delay = Math.max(5000, endAt.getTime() - Date.now());
  await scheduleJob('session-end', { userId, sessionId }, {
    jobId: `session-end__${sessionId}`,
    delay,
  });
}

async function removeSegmentJobs(session) {
  const { sessionId, currentSegmentIndex: n } = session;
  await removeJob(`session-synth__${sessionId}__${n}`);
  await removeJob(`session-recall__${sessionId}__${n}`);
}

async function removeAllSessionJobs(session) {
  const { sessionId, segments = [] } = session;
  for (let i = 0; i < segments.length; i++) {
    await removeJob(`session-synth__${sessionId}__${i}`);
    await removeJob(`session-recall__${sessionId}__${i}`);
    await removeJob(`break__${sessionId}__${i}`);
  }
  await removeJob(`session-end__${sessionId}`);
  await removeJob(`session-wrap-morning__${process.env.SINGLE_USER_ID}`);
}

// ── Session init helpers ──────────────────────────────────────────────────────

async function postSessionRecap(client, userId, channelId) {
  const historyRaw = await redis.lrange(`history:${userId}`, 0, 2);
  if (historyRaw.length === 0) {
    await client.chat.postMessage({ channel: channelId, text: '_No previous quiz history yet._' });
    return [];
  }
  const entries = historyRaw.map(r => typeof r === 'string' ? JSON.parse(r) : r);
  const lines = ['📋 *Last quizzes:*'];
  for (const e of entries) {
    const date = new Date(e.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const scope = e.scope?.module ?? e.scope?.lesson ?? 'Mixed';
    lines.push(`• ${date} — ${scope} — ${e.score}/100`);
  }
  await client.chat.postMessage({ channel: channelId, text: lines.join('\n') });
  return entries;
}

async function getWarmupConcepts(userId, recentHistory) {
  const weakIds = [...new Set(recentHistory.flatMap(e => e.conceptIds ?? []))];
  if (weakIds.length === 0) return null;
  const all = await getConcepts(userId);
  const weak = all.filter(c => weakIds.includes(c.id));
  return weak.length > 0 ? weak : null;
}

// ── Public: /focus start ──────────────────────────────────────────────────────

export async function startSession(client, userId, slackUserId, channelId, args) {
  const existing = await loadSession(userId);
  if (existing && ['active', 'on_break', 'warmup'].includes(existing.status)) {
    await client.chat.postMessage({
      channel: channelId,
      text: `You already have an active session: *${existing.topic}*\nUse \`/focus end\` to close it first.`,
    });
    return;
  }

  const plannedDuration = parseDuration(args.duration);
  const topic = args.topic;

  await client.chat.postMessage({
    channel: channelId,
    text: `Starting session: *${topic}* (${plannedDuration} min)\n\n_Where are you picking up? Reply with a quick note._`,
  });

  const pendingKey = `${slackUserId}:${channelId}`;
  pendingReplies.set(pendingKey, async (text) => {
    pendingReplies.delete(pendingKey);
    await initializeSession(client, userId, slackUserId, channelId, topic, plannedDuration, text);
  });
}

async function initializeSession(client, userId, slackUserId, channelId, topic, plannedDuration, startingContext) {
  const recentHistory = await postSessionRecap(client, userId, channelId);
  const warmupConcepts = await getWarmupConcepts(userId, recentHistory);

  await client.chat.postMessage({
    channel: channelId,
    text: `🔥 *Warm-up* — quick check before we dive in.`,
  });

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  const session = {
    sessionId,
    topic,
    startingContext,
    plannedDuration,
    segmentDuration: SEGMENT_MINUTES,
    breakDuration: 10,
    status: 'warmup',
    currentSegmentIndex: 0,
    currentSegmentStart: now,
    currentSegmentElapsed: 0,
    segments: [{
      startedAt: now, endedAt: null, activeRecallNote: null,
      useCaseNote: null, noteSkipped: false, breaks: [],
    }],
    warmupQuizId: null,
    wrapQuizId: null,
    slackChannelId: channelId,
    slackUserId,
    startedAt: now,
    completedAt: null,
  };

  await saveSession(userId, session);

  try {
    const quiz = await startQuiz(client, userId, slackUserId, channelId, {}, {
      trigger: 'session_warmup',
      concepts: warmupConcepts,
      distribution: { mcq: 1.0 },
      count: 5,
    });

    if (quiz?.quizId) {
      session.warmupQuizId = quiz.quizId;
      await saveSession(userId, session);
      registerQuizCompletion(quiz.quizId, async () => {
        await postSessionPlanAndStart(client, userId, session.sessionId);
      });
      return;
    }
  } catch (err) {
    console.error('[session] warmup quiz failed:', err);
  }

  await postSessionPlanAndStart(client, userId, session.sessionId);
}

async function postSessionPlanAndStart(client, userId, sessionId) {
  const session = await loadSession(userId);
  if (!session || session.sessionId !== sessionId) return;
  if (['abandoned', 'ending', 'completed'].includes(session.status)) return;

  const now = new Date().toISOString();
  session.status = 'active';
  session.currentSegmentStart = now;
  session.currentSegmentElapsed = 0;
  session.startedAt = now;
  if (session.segments[0]) session.segments[0].startedAt = now;
  await saveSession(userId, session);

  await client.chat.postMessage({
    channel: session.slackChannelId,
    text: formatSessionPlan(session),
  });

  await scheduleSegmentJobs(userId, session);
  await scheduleSessionEndJob(userId, session);
}

// ── Public: /focus end ────────────────────────────────────────────────────────

export async function endSession(client, userId, slackUserId, channelId) {
  const session = await loadSession(userId);
  if (!session || ['completed', 'abandoned', 'ending'].includes(session.status)) {
    await client.chat.postMessage({ channel: channelId, text: 'No active session to end.' });
    return;
  }
  await handleSessionEnd(client, userId, session.sessionId);
}

// ── Job handlers (called from scheduler) ─────────────────────────────────────

export async function handleSessionSynth(client, userId, sessionId, segmentIndex) {
  try {
    const session = await loadSession(userId);
    if (!session || session.sessionId !== sessionId) return;
    if (session.status !== 'active' || session.currentSegmentIndex !== segmentIndex) return;

    await client.chat.postMessage({
      channel: session.slackChannelId,
      text: `🧠 *5 minutes left in this segment.*\n\nStart synthesizing — wrap up what you've been working through.\nI'll ask you to write it out in 5 minutes.`,
    });
  } catch (err) {
    console.error(`[session-synth] error | userId=${userId} | sessionId=${sessionId} | ${err.message}`);
  }
}

export async function handleSessionRecall(client, userId, sessionId, segmentIndex) {
  try {
    const session = await loadSession(userId);
    if (!session || session.sessionId !== sessionId) return;
    if (session.status !== 'active' || session.currentSegmentIndex !== segmentIndex) return;

    await client.chat.postMessage({
      channel: session.slackChannelId,
      text: `⏱️ *Segment complete.*\n\nBefore your break, reply with:\n1. The most important concept from this segment\n2. How it works in one sentence\n3. One question you still have`,
    });

    const pendingKey = `${session.slackUserId}:${session.slackChannelId}`;
    pendingReplies.set(pendingKey, async (text) => {
      pendingReplies.delete(pendingKey);
      try {
        const fresh = await loadSession(userId);
        if (!fresh || fresh.sessionId !== sessionId) return;
        if (fresh.status !== 'active') return;

        if (!fresh.segments[segmentIndex]) fresh.segments[segmentIndex] = {};
        fresh.segments[segmentIndex].activeRecallNote = text;
        fresh.segments[segmentIndex].endedAt = new Date().toISOString();
        fresh.status = 'on_break';
        await saveSession(userId, fresh);

        await client.chat.postMessage({
          channel: session.slackChannelId,
          text: `Logged. Break timer: ${fresh.breakDuration} minutes.`,
        });

        await scheduleJob('break', { userId, sessionId, segmentIndex }, {
          jobId: `break__${sessionId}__${segmentIndex}`,
          delay: fresh.breakDuration * 60 * 1000,
        });
      } catch (err) {
        console.error(`[session-recall:reply] error | userId=${userId} | sessionId=${sessionId} | ${err.message}`);
      }
    });
  } catch (err) {
    console.error(`[session-recall] error | userId=${userId} | sessionId=${sessionId} | ${err.message}`);
  }
}

export async function handleBreakEnd(client, userId, sessionId, segmentIndex) {
  try {
    const session = await loadSession(userId);
    if (!session || session.sessionId !== sessionId) return;
    if (['ending', 'completed', 'abandoned'].includes(session.status)) return;
    if (session.status !== 'on_break') return;

    await client.chat.postMessage({
      channel: session.slackChannelId,
      text: `Break's up. Reply anything when you're ready.`,
    });

    const pendingKey = `${session.slackUserId}:${session.slackChannelId}`;
    pendingReplies.set(pendingKey, async (_text) => {
      pendingReplies.delete(pendingKey);
      await resumeAfterBreak(client, userId, sessionId, segmentIndex);
    });
  } catch (err) {
    console.error(`[session-break-end] error | userId=${userId} | sessionId=${sessionId} | ${err.message}`);
  }
}

async function resumeAfterBreak(client, userId, sessionId, prevSegmentIndex) {
  const session = await loadSession(userId);
  if (!session || session.sessionId !== sessionId || session.status !== 'on_break') return;

  const nextIndex = prevSegmentIndex + 1;
  const now = new Date().toISOString();

  session.status = 'active';
  session.currentSegmentIndex = nextIndex;
  session.currentSegmentStart = now;
  session.currentSegmentElapsed = 0;
  session.segments[nextIndex] = {
    startedAt: now, endedAt: null, activeRecallNote: null,
    useCaseNote: null, noteSkipped: false, breaks: [],
  };
  await saveSession(userId, session);

  const elapsedMin = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
  const remaining = Math.max(0, Math.round(session.plannedDuration - elapsedMin));

  await client.chat.postMessage({
    channel: session.slackChannelId,
    text: `Welcome back — ${remaining} minutes left in your session.`,
  });

  await scheduleSegmentJobs(userId, session);
}

export async function handleSessionEnd(client, userId, sessionId) {
  const session = await loadSession(userId);
  if (!session || session.sessionId !== sessionId) return;
  if (['completed', 'abandoned', 'ending'].includes(session.status)) return;

  // Mark ending immediately to prevent double invocation (BullMQ fire + /focus end race)
  session.status = 'ending';
  await saveSession(userId, session);

  // Cancel scheduled jobs that haven't fired yet
  await removeSegmentJobs(session);
  await removeJob(`session-end__${sessionId}`);
  await removeJob(`break__${sessionId}__${session.currentSegmentIndex}`);

  // Clear any stale pending reply (e.g., recall note waiting) before registering the end handler
  const pendingKey = `${session.slackUserId}:${session.slackChannelId}`;
  pendingReplies.delete(pendingKey);

  await client.chat.postMessage({
    channel: session.slackChannelId,
    text: `🎓 *Session complete.*\n\nBefore you close out — reply with one concept from tonight and how you'd apply it at work or in something you're building.`,
  });

  pendingReplies.set(pendingKey, async (text) => {
    pendingReplies.delete(pendingKey);
    const fresh = await loadSession(userId);
    if (!fresh || fresh.sessionId !== sessionId) return;

    const segIdx = fresh.currentSegmentIndex;
    if (fresh.segments[segIdx]) fresh.segments[segIdx].useCaseNote = text;
    fresh.status = 'completed';
    fresh.completedAt = new Date().toISOString();
    await saveSession(userId, fresh);

    const durationMin = Math.round(
      (new Date(fresh.completedAt) - new Date(fresh.startedAt)) / 60000
    );
    const completedSegments = fresh.segments.filter(s => s.endedAt).length;

    await client.chat.postMessage({
      channel: session.slackChannelId,
      text: `📊 *Session Summary*\n• Topic: ${fresh.topic}\n• Duration: ${durationMin} min\n• Segments completed: ${completedSegments}`,
    });

    await client.chat.postMessage({
      channel: session.slackChannelId,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Want to lock in what you learned with a quick quiz?' },
        },
        {
          type: 'actions',
          block_id: `wrap_quiz_${sessionId}`,
          elements: [
            {
              type: 'button',
              action_id: 'session_wrap_now',
              text: { type: 'plain_text', text: 'Quiz Now' },
              value: JSON.stringify({ userId, sessionId }),
              style: 'primary',
            },
            {
              type: 'button',
              action_id: 'session_wrap_tomorrow',
              text: { type: 'plain_text', text: 'Tomorrow Morning' },
              value: JSON.stringify({ userId, sessionId }),
            },
            {
              type: 'button',
              action_id: 'session_wrap_skip',
              text: { type: 'plain_text', text: 'Skip' },
              value: JSON.stringify({ userId, sessionId }),
            },
          ],
        },
      ],
      text: 'Session complete — quiz offer',
    });
  });
}

export async function handleSessionWrapMorning(client, userId, sessionId) {
  const session = await loadSession(userId);
  const channelId = session?.slackChannelId;
  const slackUserId = session?.slackUserId ?? process.env.SLACK_USER_ID;
  if (!channelId) return;

  await startQuiz(client, userId, slackUserId, channelId, {}, {
    trigger: 'session_wrap',
    distribution: { mcq: 1.0 },
    count: 5,
  });
}

// ── Dynamic break detection ───────────────────────────────────────────────────

async function handleBreakDetection(client, userId, channelId, text) {
  const session = await loadSession(userId);
  if (!session || session.status !== 'active') return;
  if (session.slackChannelId !== channelId) return;

  const breakMins = parseBreakDuration(text, session.breakDuration);
  const segIdx = session.currentSegmentIndex;

  const elapsedSecs =
    Math.round((Date.now() - new Date(session.currentSegmentStart).getTime()) / 1000) +
    session.currentSegmentElapsed;

  session.currentSegmentElapsed = elapsedSecs;
  session.status = 'on_break';
  if (session.segments[segIdx]) {
    session.segments[segIdx].breaks = session.segments[segIdx].breaks ?? [];
    session.segments[segIdx].breaks.push({ startedAt: new Date().toISOString(), minutes: breakMins });
  }
  await saveSession(userId, session);

  await removeSegmentJobs(session);

  await scheduleJob('break', { userId, sessionId: session.sessionId, segmentIndex: segIdx }, {
    jobId: `break__${session.sessionId}__${segIdx}`,
    delay: breakMins * 60 * 1000,
  });

  await client.chat.postMessage({
    channel: channelId,
    text: `Got it — break timer set for ${breakMins} minutes.`,
  });
}

// ── Bolt handlers ─────────────────────────────────────────────────────────────

export function registerSessionHandlers() {
  const userId = process.env.SINGLE_USER_ID;

  boltApp.message(async ({ message, client }) => {
    if (message.subtype) return;
    const text = message.text ?? '';
    const channelId = message.channel;
    const msgUserId = message.user;

    const pendingKey = `${msgUserId}:${channelId}`;
    const handler = pendingReplies.get(pendingKey);
    if (handler) {
      await handler(text);
      return;
    }

    if (isBreakMessage(text)) {
      await handleBreakDetection(client, userId, channelId, text);
    }
  });

  boltApp.action('session_wrap_now', async ({ ack, body, client }) => {
    await ack();
    try {
      const { userId: uid, sessionId } = JSON.parse(body.actions[0].value);
      await startQuiz(client, uid, body.user.id, body.channel.id, {}, {
        trigger: 'session_wrap',
        distribution: { mcq: 1.0 },
        count: 5,
      });
    } catch (err) {
      console.error(`[session_wrap_now] error | slackUser=${body.user?.id} | ${err.message}`);
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: '⚠️ Something went wrong starting the wrap-up quiz.' }).catch(() => {});
    }
  });

  boltApp.action('session_wrap_tomorrow', async ({ ack, body, client }) => {
    await ack();
    try {
      const { userId: uid, sessionId } = JSON.parse(body.actions[0].value);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(8, 30, 0, 0);
      const delay = Math.max(0, tomorrow.getTime() - Date.now());

      await scheduleJob('session-wrap-morning', { userId: uid, sessionId }, {
        jobId: `session-wrap-morning__${uid}`,
        delay,
      });

      await client.chat.postMessage({
        channel: body.channel.id,
        text: `Got it — wrap-up quiz scheduled for tomorrow morning. 🌅`,
      });
    } catch (err) {
      console.error(`[session_wrap_tomorrow] error | slackUser=${body.user?.id} | ${err.message}`);
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text: '⚠️ Something went wrong scheduling the morning quiz.' }).catch(() => {});
    }
  });

  boltApp.action('session_wrap_skip', async ({ ack, body, client }) => {
    await ack();
    try {
      const { userId: uid, sessionId } = JSON.parse(body.actions[0].value);
      const session = await loadSession(uid);
      if (session && session.sessionId === sessionId) {
        await removeAllSessionJobs(session);
      }
      await client.chat.postMessage({
        channel: body.channel.id,
        text: `Session closed. Great work! 🎓`,
      });
    } catch (err) {
      console.error(`[session_wrap_skip] error | slackUser=${body.user?.id} | ${err.message}`);
    }
  });
}
