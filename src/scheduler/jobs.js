import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { redis } from '../redis.js';
import { getConcepts } from '../lib/concepts.js';
import { getAllMastery } from '../lib/mastery.js';
import { getDMChannel } from '../slack/dm.js';
import { startQuiz } from '../slack/quizFlow.js';
import { buildMasterySnapshot, formatWeeklyDigestBlocks } from '../slack/masteryFlow.js';

const PING_DISTRIBUTION = { mcq: 1.0 };
const PING_COUNT = 3;

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

let queue = null;
let slackClient = null;

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(userId) {
  const raw = await redis.get(`settings:${userId}`);
  const stored = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  return {
    pingEnabled: true,
    pingWindowStart: '09:00',
    pingWindowEnd: '18:00',
    pingDaysOfWeek: [1, 2, 3, 4, 5],
    pingFrequencyPerDay: 2,
    morningQuizTime: '08:30',
    weeklyDigestDay: 0,
    weeklyDigestTime: '19:00',
    timezone: process.env.USER_TIMEZONE ?? 'America/Chicago',
    ...stored,
  };
}

// ── Timezone helpers ──────────────────────────────────────────────────────────

function getLocalTimeParts(timezone) {
  const now = new Date();
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hourStr, minuteStr] = timeFmt.format(now).split(':');

  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = dayNames.indexOf(dayFmt.format(now));

  return { hour: parseInt(hourStr), minute: parseInt(minuteStr), dayOfWeek };
}

function parseHHMM(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function msUntilNextPing(settings) {
  const { timezone, pingWindowStart, pingWindowEnd, pingDaysOfWeek } = settings;
  const { hour, minute, dayOfWeek } = getLocalTimeParts(timezone);

  const nowMins = hour * 60 + minute;
  const startMins = parseHHMM(pingWindowStart);
  const endMins = parseHHMM(pingWindowEnd);

  const inWindow =
    pingDaysOfWeek.includes(dayOfWeek) && nowMins >= startMins && nowMins < endMins;

  if (inWindow) {
    const remainingMins = endMins - nowMins;
    if (remainingMins >= 30) {
      // Random time in remaining window, at least 15 minutes out
      const offset = 15 + Math.floor(Math.random() * (remainingMins - 15));
      return offset * 60 * 1000;
    }
  }

  // Find next valid day
  let daysAhead = 1;
  while (daysAhead <= 7) {
    if (pingDaysOfWeek.includes((dayOfWeek + daysAhead) % 7)) break;
    daysAhead++;
  }

  // Random offset 0–120 min into the window
  const windowOffset = Math.floor(Math.random() * 120);
  const minsUntilMidnight = 24 * 60 - nowMins;
  const totalMins = minsUntilMidnight + (daysAhead - 1) * 24 * 60 + startMins + windowOffset;

  return totalMins * 60 * 1000;
}

// ── Concept selection for scheduled pings ─────────────────────────────────────

async function selectPingConcepts(userId) {
  const concepts = await getConcepts(userId);
  if (concepts.length === 0) return [];

  const masteryObjects = await getAllMastery(userId, concepts.map((c) => c.id));
  const now = new Date();

  const overdue = concepts
    .filter((_, i) => {
      const nr = masteryObjects[i].nextReviewAt;
      return nr && new Date(nr) <= now;
    })
    .slice(0, 3);

  const overdueIds = new Set(overdue.map((c) => c.id));
  const pool = concepts.filter((c) => !overdueIds.has(c.id));
  const needed = Math.max(0, 5 - overdue.length);
  const fill = pool.sort(() => Math.random() - 0.5).slice(0, needed);

  return [...overdue, ...fill];
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function handlePing(job) {
  const { userId } = job.data;
  const settings = await getSettings(userId);

  if (!settings.pingEnabled) {
    console.log(`[scheduler] Ping disabled for ${userId}, skipping`);
    await schedulePing(userId);
    return;
  }

  const { dayOfWeek, hour, minute } = getLocalTimeParts(settings.timezone);
  const nowMins = hour * 60 + minute;
  const startMins = parseHHMM(settings.pingWindowStart);
  const endMins = parseHHMM(settings.pingWindowEnd);
  const inWindow =
    settings.pingDaysOfWeek.includes(dayOfWeek) && nowMins >= startMins && nowMins < endMins;

  if (!inWindow) {
    console.log(`[scheduler] Outside ping window for ${userId}, rescheduling`);
    await schedulePing(userId);
    return;
  }

  try {
    const slackUserId = process.env.SLACK_USER_ID;
    const channelId = await getDMChannel(slackClient, slackUserId);
    const concepts = await selectPingConcepts(userId);

    if (concepts.length === 0) {
      console.log(`[scheduler] No concepts for ${userId}, skipping ping`);
    } else {
      await startQuiz(slackClient, userId, slackUserId, channelId, {}, {
        trigger: 'scheduled_ping',
        concepts,
        distribution: PING_DISTRIBUTION,
        count: PING_COUNT,
      });
    }
  } catch (err) {
    console.error('[scheduler] handlePing error:', err);
  }

  await schedulePing(userId);
}

async function handleWeeklyDigest(job) {
  const { userId } = job.data;
  try {
    const slackUserId = process.env.SLACK_USER_ID;
    const channelId = await getDMChannel(slackClient, slackUserId);
    const snapshot = await buildMasterySnapshot(userId);

    if (!snapshot) {
      await slackClient.chat.postMessage({ channel: channelId, text: 'No concepts in your library yet.' });
      return;
    }

    // Load snapshot from 7 days ago for delta
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000)
      .toISOString()
      .slice(0, 10);
    const prevRaw = await redis.get(`mastery-snapshot:${userId}:${sevenDaysAgo}`);
    const previousSnapshot = prevRaw
      ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw)
      : null;

    // Weekly stats from history
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    const historyRaw = await redis.lrange(`history:${userId}`, 0, 29);
    const weekEntries = historyRaw
      .map((r) => (typeof r === 'string' ? JSON.parse(r) : r))
      .filter((e) => e.completedAt >= cutoff);

    const quizCount = weekEntries.length;
    const conceptsTested = new Set(weekEntries.flatMap((e) => e.conceptIds ?? [])).size;

    const blocks = formatWeeklyDigestBlocks(snapshot, previousSnapshot, { quizCount, conceptsTested });
    await slackClient.chat.postMessage({
      channel: channelId,
      blocks,
      text: '\ud83d\udcca Weekly Digest',
    });
  } catch (err) {
    console.error('[scheduler] handleWeeklyDigest error:', err);
  }
}

async function handleDailySnapshot(job) {
  const { userId } = job.data;
  try {
    const snapshot = await buildMasterySnapshot(userId);
    if (!snapshot) return;

    const date = new Date().toISOString().slice(0, 10);
    const record = {
      date,
      modules: snapshot.modules.map(({ name, avg }) => ({ name, avg })),
    };
    await redis.set(`mastery-snapshot:${userId}:${date}`, JSON.stringify(record));
    console.log(`[scheduler] Daily snapshot written for ${userId} on ${date}`);
  } catch (err) {
    console.error('[scheduler] handleDailySnapshot error:', err);
  }
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

export async function schedulePing(userId) {
  const settings = await getSettings(userId);
  if (!settings.pingEnabled) return;

  const delay = msUntilNextPing(settings);
  await queue.add('slack-ping', { userId }, {
    jobId: `slack-ping:${userId}`,
    delay,
    removeOnComplete: true,
    removeOnFail: 5,
  });
  const mins = Math.round(delay / 60000);
  console.log(`[scheduler] Next ping for ${userId} in ~${mins} min`);
}

// For session jobs — idempotent: removes existing job with same ID before adding
export async function scheduleJob(name, data, opts = {}) {
  if (opts.jobId) await removeJob(opts.jobId);
  return queue.add(name, data, { removeOnComplete: true, removeOnFail: 5, ...opts });
}

export async function removeJob(jobId) {
  const job = await queue.getJob(jobId);
  if (job) await job.remove();
}

// ── Startup ───────────────────────────────────────────────────────────────────

export async function startScheduler(client, userId, sessionHandlers = {}) {
  slackClient = client;

  queue = new Queue('studybuddy', { connection });

  const worker = new Worker(
    'studybuddy',
    async (job) => {
      switch (job.name) {
        case 'slack-ping':            return handlePing(job);
        case 'weekly-digest':         return handleWeeklyDigest(job);
        case 'daily-snapshot':        return handleDailySnapshot(job);
        case 'session-synth':         return sessionHandlers.synth?.(job);
        case 'session-recall':        return sessionHandlers.recall?.(job);
        case 'session-end':           return sessionHandlers.sessionEnd?.(job);
        case 'break':                 return sessionHandlers.breakEnd?.(job);
        case 'session-wrap-morning':  return sessionHandlers.wrapMorning?.(job);
        default:
          console.warn(`[scheduler] Unhandled job: ${job.name}`);
      }
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    console.error(`[scheduler] ${job?.name} (${job?.id}) failed:`, err.message);
  });

  const settings = await getSettings(userId);

  // Weekly digest cron
  const [digestH, digestM] = settings.weeklyDigestTime.split(':');
  await queue.upsertJobScheduler(
    `weekly-digest:${userId}`,
    {
      pattern: `${digestM} ${digestH} * * ${settings.weeklyDigestDay}`,
      tz: settings.timezone,
    },
    { name: 'weekly-digest', data: { userId } }
  );

  // Daily snapshot cron (midnight in user's timezone)
  await queue.upsertJobScheduler(
    `daily-snapshot:${userId}`,
    { pattern: '0 0 * * *', tz: settings.timezone },
    { name: 'daily-snapshot', data: { userId } }
  );

  // Initial ping (idempotent — jobId prevents duplicates)
  await schedulePing(userId);

  console.log(`[scheduler] Started for ${userId}`);
}
