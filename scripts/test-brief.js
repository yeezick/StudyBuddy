import '../src/lib/env.js';
import { redis } from '../src/redis.js';
import { setMastery } from '../src/lib/mastery.js';
import { buildBriefSnapshot, formatBriefBlocks } from '../src/slack/briefFlow.js';

const TEST_USER = 'test-brief-temp';

function header(label) {
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONCEPTS = [
  { id: 'tb-c01', name: 'Alpha', scope: { course: 'Test', module: 'Module 1' } },
  { id: 'tb-c02', name: 'Beta',  scope: { course: 'Test', module: 'Module 1' } },
];

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString();
}

async function seedConcepts() {
  await redis.set(`concepts:${TEST_USER}`, JSON.stringify(CONCEPTS));
}

async function seedMastery(nextReviewDays) {
  for (let i = 0; i < CONCEPTS.length; i++) {
    await setMastery(TEST_USER, {
      conceptId: CONCEPTS[i].id,
      score: 0.3,
      easeFactor: 2.5,
      interval: 1,
      repetitions: 1,
      nextReviewAt: daysFromNow(nextReviewDays[i]),
      lastReviewedAt: new Date().toISOString(),
    });
  }
}

async function seedSession(status, topic = 'Module 1') {
  const session = {
    sessionId: 'test-session-id',
    topic,
    status,
    currentSegmentIndex: 0,
    currentSegmentStart: new Date(Date.now() - 20 * 60000).toISOString(), // 20 min ago
    slackChannelId: 'D000',
    slackUserId: 'U000',
    startedAt: new Date().toISOString(),
  };
  await redis.set(`session:${TEST_USER}`, JSON.stringify(session));
}

async function seedHistory(entries) {
  await redis.del(`history:${TEST_USER}`);
  for (const e of entries) {
    await redis.lpush(`history:${TEST_USER}`, JSON.stringify(e));
  }
}

async function cleanup() {
  await redis.del(`concepts:${TEST_USER}`);
  await redis.del(`session:${TEST_USER}`);
  await redis.del(`history:${TEST_USER}`);
  for (const c of CONCEPTS) await redis.del(`mastery:${TEST_USER}:${c.id}`);
  console.log(`\n  deleted test keys`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

header('1. Empty state — no session, no history, no mastery');
await seedConcepts();
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  assert(snapshot.session === null, 'session is null');
  assert(snapshot.lastQuiz === null, 'lastQuiz is null');

  const blocks = formatBriefBlocks(snapshot);
  const body = blocks[1].text.text;
  assert(body.includes('No active session'), 'shows no active session');
  assert(body.includes('No reviews scheduled'), 'shows no reviews scheduled');
  assert(body.includes('No quizzes taken yet'), 'shows no quizzes taken');
}

header('2. Next review — due today (overdue)');
await seedMastery([-1, 3]);
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  assert(snapshot.nextReview !== null, 'nextReview present');
  assert(snapshot.nextReview.concept.name === 'Alpha', 'earliest review is Alpha (overdue)');
  const blocks = formatBriefBlocks(snapshot);
  assert(blocks[1].text.text.includes('due today'), 'label: due today');
}

header('3. Next review — tomorrow');
await seedMastery([1, 5]);
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  const blocks = formatBriefBlocks(snapshot);
  assert(blocks[1].text.text.includes('Alpha'), 'earliest review concept name present');
  assert(blocks[1].text.text.includes('tomorrow'), 'label: tomorrow');
}

header('4. Next review — N days out');
await seedMastery([4, 9]);
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  const blocks = formatBriefBlocks(snapshot);
  assert(blocks[1].text.text.includes('in 4 days'), 'label: in 4 days');
}

header('5. Active session');
await seedSession('active', 'Module 2 Deep Dive');
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  assert(snapshot.session?.status === 'active', 'session status is active');
  const blocks = formatBriefBlocks(snapshot);
  const body = blocks[1].text.text;
  assert(body.includes('Active'), 'shows Active');
  assert(body.includes('Module 2 Deep Dive'), 'shows topic');
  assert(body.includes('Segment 1'), 'shows segment number');
  assert(body.includes('min elapsed'), 'shows elapsed time');
}

header('6. On break');
await seedSession('on_break', 'Module 1 Review');
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  const blocks = formatBriefBlocks(snapshot);
  assert(blocks[1].text.text.includes('On break'), 'shows On break');
  assert(blocks[1].text.text.includes('Module 1 Review'), 'shows topic');
}

header('7. Last quiz — with scope and date');
await redis.del(`session:${TEST_USER}`);
const yesterday = new Date(Date.now() - 86400000).toISOString();
await seedHistory([
  { quizId: 'q1', score: 82, scope: { module: 'Module 2' }, completedAt: yesterday },
]);
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  assert(snapshot.lastQuiz !== null, 'lastQuiz present');
  const blocks = formatBriefBlocks(snapshot);
  const body = blocks[1].text.text;
  assert(body.includes('82/100'), 'shows score');
  assert(body.includes('Module 2'), 'shows scope');
  assert(body.includes('yesterday'), 'shows yesterday label');
}

header('8. Last quiz — today');
const now = new Date().toISOString();
await seedHistory([
  { quizId: 'q2', score: 70, scope: null, completedAt: now },
]);
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  const blocks = formatBriefBlocks(snapshot);
  const body = blocks[1].text.text;
  assert(body.includes('70/100'), 'shows score');
  assert(body.includes('all concepts'), 'falls back to all concepts when scope is null');
  assert(body.includes('today'), 'shows today label');
}

header('9. Block structure');
{
  const snapshot = await buildBriefSnapshot(TEST_USER);
  const blocks = formatBriefBlocks(snapshot);
  assert(blocks.length === 2, 'exactly 2 blocks');
  assert(blocks[0].type === 'section', 'block 0 is section');
  assert(blocks[1].type === 'section', 'block 1 is section');
  assert(blocks[0].text.text.includes('Brief'), 'header block contains Brief');
}

header('10. Cleanup');
await cleanup();

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.error(`❌ ${failures} ASSERTION(S) FAILED`);
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED');
}
console.log('='.repeat(60));
