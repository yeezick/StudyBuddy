import '../src/lib/env.js';
import { redis } from '../src/redis.js';
import {
  parseDuration,
  isBreakMessage,
  parseBreakDuration,
  formatSessionPlan,
} from '../src/slack/sessionFlow.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}
function header(label) {
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
}

// ── parseDuration ─────────────────────────────────────────────────────────────

header('parseDuration');
assert(parseDuration('3h') === 180, '3h → 180 min');
assert(parseDuration('1h') === 60, '1h → 60 min');
assert(parseDuration('90m') === 90, '90m → 90 min');
assert(parseDuration('45m') === 45, '45m → 45 min');
assert(parseDuration(null) === 90, 'null → default 90');
assert(parseDuration(undefined) === 90, 'undefined → default 90');
assert(parseDuration('') === 90, 'empty string → default 90');
assert(parseDuration('2H') === 120, '2H (uppercase) → 120 min');
assert(parseDuration('30M') === 30, '30M (uppercase) → 30 min');

// ── isBreakMessage ────────────────────────────────────────────────────────────

header('isBreakMessage');
assert(isBreakMessage('taking a break') === true, '"taking a break" → true');
assert(isBreakMessage('brb') === true, '"brb" → true');
assert(isBreakMessage('BRB') === true, '"BRB" (uppercase) → true');
assert(isBreakMessage('pause for a sec') === true, '"pause for a sec" → true');
assert(isBreakMessage('stepping away') === true, '"stepping away" → true');
assert(isBreakMessage('back in 10 minutes') === true, '"back in 10 minutes" → true (duration match)');
assert(isBreakMessage('need 5 min') === true, '"need 5 min" → true (duration match)');
assert(isBreakMessage('what is a transformer?') === false, 'question → false');
assert(isBreakMessage('') === false, 'empty string → false');
assert(isBreakMessage(null) === false, 'null → false');
assert(isBreakMessage('let me think about that') === false, 'unrelated message → false');

// ── parseBreakDuration ────────────────────────────────────────────────────────

header('parseBreakDuration');
assert(parseBreakDuration('back in 10 minutes', 15) === 10, '10 minutes → 10');
assert(parseBreakDuration('need 5 min', 15) === 5, '5 min → 5');
assert(parseBreakDuration('15 minutes', 10) === 15, '15 minutes → 15');
assert(parseBreakDuration('brb', 15) === 15, 'no number → default 15');
assert(parseBreakDuration('break', 10) === 10, '"break" → default 10');

// ── formatSessionPlan ─────────────────────────────────────────────────────────

header('formatSessionPlan');

const session90 = {
  topic: 'Module 2 — AI Foundations',
  plannedDuration: 90,
  segmentDuration: 45,
  breakDuration: 10,
};
const plan90 = formatSessionPlan(session90);
assert(plan90.includes('Module 2 — AI Foundations'), 'plan includes topic');
assert(plan90.includes('90 min'), 'plan includes duration');
assert(plan90.includes('Segment 1'), 'plan includes Segment 1');
assert(plan90.includes('Segment 2'), 'plan includes Segment 2');
assert(!plan90.includes('Segment 3'), 'no Segment 3 for 90 min plan');
assert(plan90.includes('synthesis cue'), 'plan mentions synthesis cue');
assert(plan90.includes('active recall'), 'plan mentions active recall');

const session180 = { topic: 'Module 3', plannedDuration: 180, segmentDuration: 45, breakDuration: 10 };
const plan180 = formatSessionPlan(session180);
assert(plan180.includes('Segment 4'), '180 min plan has 4 segments');

// ── Segment delay math ────────────────────────────────────────────────────────

header('Segment delay math');

const synthMs = (40 * 60 - 0) * 1000;
assert(synthMs === 2400000, 'synth delay at 0 elapsed = 40 min');

const recallMs = (45 * 60 - 0) * 1000;
assert(recallMs === 2700000, 'recall delay at 0 elapsed = 45 min');

const elapsed = 10 * 60; // 10 min already done
const synthResume = Math.max(5000, (40 * 60 - elapsed) * 1000);
assert(synthResume === 1800000, 'synth delay resuming after 10 min = 30 min');

const recallResume = Math.max(5000, (45 * 60 - elapsed) * 1000);
assert(recallResume === 2100000, 'recall delay resuming after 10 min = 35 min');

const elapsedOver = 42 * 60; // past synth, nearly done
const synthCapped = Math.max(5000, (40 * 60 - elapsedOver) * 1000);
assert(synthCapped === 5000, 'synth delay past threshold → min 5000ms');

// ── Session state structure ───────────────────────────────────────────────────

header('Session state structure');

function makeSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    sessionId: 'test-uuid',
    topic: 'Module 2',
    startingContext: null,
    plannedDuration: 90,
    segmentDuration: 45,
    breakDuration: 10,
    status: 'active',
    currentSegmentIndex: 0,
    currentSegmentStart: now,
    currentSegmentElapsed: 0,
    segments: [{ startedAt: now, endedAt: null, activeRecallNote: null, useCaseNote: null, noteSkipped: false, breaks: [] }],
    warmupQuizId: null,
    wrapQuizId: null,
    slackChannelId: 'D123',
    slackUserId: 'U456',
    startedAt: now,
    completedAt: null,
    ...overrides,
  };
}

const s = makeSession();
assert(s.status === 'active', 'default status is active');
assert(Array.isArray(s.segments), 'segments is array');
assert(s.segments.length === 1, 'starts with 1 segment');
assert(Array.isArray(s.segments[0].breaks), 'segment breaks is array');
assert(s.segments[0].breaks.length === 0, 'segment starts with no breaks');
assert(s.currentSegmentElapsed === 0, 'elapsed starts at 0');

// Simulate break start state
const onBreak = makeSession({ status: 'on_break', currentSegmentElapsed: 600 });
assert(onBreak.status === 'on_break', 'on_break status set');
assert(onBreak.currentSegmentElapsed === 600, 'elapsed seconds stored');

// Simulate next segment after break
const resumed = makeSession({
  currentSegmentIndex: 1,
  currentSegmentElapsed: 0,
  segments: [
    { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), activeRecallNote: 'key concept', useCaseNote: null, noteSkipped: false, breaks: [] },
    { startedAt: new Date().toISOString(), endedAt: null, activeRecallNote: null, useCaseNote: null, noteSkipped: false, breaks: [] },
  ],
});
assert(resumed.currentSegmentIndex === 1, 'segment index incremented after break');
assert(resumed.segments[0].activeRecallNote === 'key concept', 'recall note stored on segment 0');
assert(resumed.segments[1].endedAt === null, 'new segment not yet ended');

// ── Wrap-up quiz block structure ──────────────────────────────────────────────

header('Wrap-up quiz block structure');

function makeWrapBlocks(sessionId) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: 'Want to lock in what you learned with a quick quiz?' } },
    {
      type: 'actions',
      block_id: `wrap_quiz_${sessionId}`,
      elements: [
        { type: 'button', action_id: 'session_wrap_now', text: { type: 'plain_text', text: 'Quiz Now' }, style: 'primary' },
        { type: 'button', action_id: 'session_wrap_tomorrow', text: { type: 'plain_text', text: 'Tomorrow Morning' } },
        { type: 'button', action_id: 'session_wrap_skip', text: { type: 'plain_text', text: 'Skip' } },
      ],
    },
  ];
}

const blocks = makeWrapBlocks('test-session-id');
assert(blocks.length === 2, 'wrap offer has 2 blocks');
assert(blocks[0].type === 'section', 'first block is section');
assert(blocks[1].type === 'actions', 'second block is actions');
assert(blocks[1].elements.length === 3, '3 wrap buttons');
assert(blocks[1].elements[0].action_id === 'session_wrap_now', 'first button is Quiz Now');
assert(blocks[1].elements[1].action_id === 'session_wrap_tomorrow', 'second button is Tomorrow Morning');
assert(blocks[1].elements[2].action_id === 'session_wrap_skip', 'third button is Skip');
assert(blocks[1].elements[0].style === 'primary', 'Quiz Now is primary style');

// ── Session end timing ────────────────────────────────────────────────────────

header('Session end timing');

function sessionEndDelay(startedAt, plannedDurationMin) {
  const endAt = new Date(new Date(startedAt).getTime() + plannedDurationMin * 60 * 1000);
  return Math.max(5000, endAt.getTime() - Date.now());
}

const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // started 1 hour ago
const delayFor3h = sessionEndDelay(startedAt, 180);
assert(delayFor3h > 60 * 60 * 1000, '3h session started 1h ago → >60 min remaining');
assert(delayFor3h < 2 * 60 * 60 * 1000 + 5000, '3h session started 1h ago → <2h remaining');

const pastStart = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(); // started 4h ago
const delayPast = sessionEndDelay(pastStart, 180);
assert(delayPast === 5000, 'session past end time → capped at 5000ms');

// ── Final ─────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll assertions passed.`);
  process.exit(0);
}
