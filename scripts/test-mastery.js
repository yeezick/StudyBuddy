import '../src/lib/env.js';
import { redis } from '../src/redis.js';
import { setMastery } from '../src/lib/mastery.js';
import { buildMasterySnapshot, formatMasteryBlocks } from '../src/slack/masteryFlow.js';

const TEST_USER = 'test-mastery-temp';

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const CONCEPTS = [
  { id: 'tc-m1-c01', name: 'Alpha', scope: { course: 'Test Course', module: 'Module 1' } },
  { id: 'tc-m1-c02', name: 'Beta',  scope: { course: 'Test Course', module: 'Module 1' } },
  { id: 'tc-m2-c01', name: 'Gamma', scope: { course: 'Test Course', module: 'Module 2' } },
  { id: 'tc-m2-c02', name: 'Delta', scope: { course: 'Test Course', module: 'Module 2' } },
];

async function seedConcepts() {
  await redis.set(`concepts:${TEST_USER}`, JSON.stringify(CONCEPTS));
}

async function seedMastery({ scores = [], overdueIds = [] } = {}) {
  for (let i = 0; i < CONCEPTS.length; i++) {
    const c = CONCEPTS[i];
    const score = scores[i] ?? 0;
    const overdue = overdueIds.includes(c.id);
    const nextReviewAt = overdue
      ? new Date(Date.now() - 86400 * 1000).toISOString() // yesterday
      : new Date(Date.now() + 86400 * 1000).toISOString(); // tomorrow
    await setMastery(TEST_USER, {
      conceptId: c.id,
      score,
      easeFactor: 2.5,
      interval: 1,
      repetitions: score > 0 ? 1 : 0,
      nextReviewAt,
      lastReviewedAt: new Date().toISOString(),
    });
  }
}

async function cleanup() {
  await redis.del(`concepts:${TEST_USER}`);
  for (const c of CONCEPTS) {
    await redis.del(`mastery:${TEST_USER}:${c.id}`);
  }
  console.log(`\n  deleted ${CONCEPTS.length + 1} test keys`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

header('1. Bar math');
{
  function masteryBar(score) {
    const filled = Math.round(score * 10);
    return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  }

  assert(masteryBar(0)    === '░░░░░░░░░░', 'score 0.0 → 10 empty');
  assert(masteryBar(1)    === '██████████', 'score 1.0 → 10 filled');
  assert(masteryBar(0.5)  === '█████░░░░░', 'score 0.5 → 5 filled');
  assert(masteryBar(0.78) === '████████░░', 'score 0.78 → rounds to 8 filled');
  assert(masteryBar(0.45) === '█████░░░░░', 'score 0.45 → rounds to 5 filled (Math.round(4.5) = 5)');
  assert(masteryBar(0.75) === '████████░░', 'score 0.75 → rounds to 8 filled');
  assert(masteryBar(0.15) === '██░░░░░░░░', 'score 0.15 → rounds to 2 filled');

  const bar78 = masteryBar(0.78);
  assert(bar78.length === 10, 'bar is always 10 chars');
}

header('2. buildMasterySnapshot — structure');
await seedConcepts();
await seedMastery({ scores: [0.3, 0.6, 0.0, 0.9] });
{
  const snapshot = await buildMasterySnapshot(TEST_USER);

  assert(snapshot !== null, 'returns non-null snapshot');
  assert(snapshot.courseName === 'Test Course', 'courseName extracted from concepts');
  assert(Array.isArray(snapshot.modules), 'modules is array');
  assert(snapshot.modules.length === 2, 'two modules grouped correctly');

  const m1 = snapshot.modules.find((m) => m.name === 'Module 1');
  const m2 = snapshot.modules.find((m) => m.name === 'Module 2');

  assert(m1 !== undefined, 'Module 1 present');
  assert(m1.count === 2, 'Module 1 has 2 concepts');
  assert(Math.abs(m1.avg - 0.45) < 0.001, `Module 1 avg = 0.45 (got ${m1.avg})`);

  assert(m2 !== undefined, 'Module 2 present');
  assert(m2.count === 2, 'Module 2 has 2 concepts');
  assert(Math.abs(m2.avg - 0.45) < 0.001, `Module 2 avg = 0.45 (got ${m2.avg})`);
}

header('3. buildMasterySnapshot — due for review');
await seedMastery({ scores: [0.3, 0.6, 0.0, 0.9], overdueIds: ['tc-m1-c01', 'tc-m2-c02'] });
{
  const snapshot = await buildMasterySnapshot(TEST_USER);

  assert(snapshot.dueToday.length === 2, 'two concepts overdue');
  assert(snapshot.dueToday.includes('Alpha'), 'Alpha (tc-m1-c01) in dueToday');
  assert(snapshot.dueToday.includes('Delta'), 'Delta (tc-m2-c02) in dueToday');
  assert(!snapshot.dueToday.includes('Beta'), 'Beta not due (nextReviewAt in future)');
}

header('4. buildMasterySnapshot — no concepts due');
await seedMastery({ scores: [0.3, 0.6, 0.0, 0.9], overdueIds: [] });
{
  const snapshot = await buildMasterySnapshot(TEST_USER);
  assert(snapshot.dueToday.length === 0, 'dueToday empty when nothing overdue');
}

header('5. buildMasterySnapshot — empty library');
await redis.del(`concepts:${TEST_USER}`);
{
  const snapshot = await buildMasterySnapshot(TEST_USER);
  assert(snapshot === null, 'returns null for empty concept library');
}

header('6. formatMasteryBlocks — structure');
await seedConcepts();
await seedMastery({ scores: [0.6, 0.8, 0.2, 0.4], overdueIds: ['tc-m1-c01'] });
{
  const snapshot = await buildMasterySnapshot(TEST_USER);
  const blocks = formatMasteryBlocks(snapshot);

  assert(Array.isArray(blocks), 'returns array of blocks');
  assert(blocks.length >= 3, 'at least 3 blocks (header, bars, cta)');

  const headerBlock = blocks[0];
  assert(headerBlock.type === 'section', 'first block is section');
  assert(headerBlock.text.text.includes('Test Course'), 'header includes course name');
  assert(headerBlock.text.text.includes('Mastery Snapshot'), 'header includes title');

  const barBlock = blocks[1];
  assert(barBlock.text.text.includes('Module 1'), 'bar block includes Module 1');
  assert(barBlock.text.text.includes('Module 2'), 'bar block includes Module 2');
  assert(barBlock.text.text.includes('%'), 'bar block includes percentage');
  assert(barBlock.text.text.includes('concepts'), 'bar block includes concept count');

  const dueBlock = blocks.find((b) => b.text?.text?.includes('Due for review'));
  assert(dueBlock !== undefined, 'due-for-review block present when concepts overdue');
  assert(dueBlock.text.text.includes('Alpha'), 'overdue concept name appears in due block');

  const ctaBlock = blocks[blocks.length - 1];
  assert(ctaBlock.text.text.includes('/quizinit'), 'CTA block includes /quizinit');
}

header('7. formatMasteryBlocks — no due concepts');
await seedMastery({ scores: [0.3, 0.6, 0.0, 0.9], overdueIds: [] });
{
  const snapshot = await buildMasterySnapshot(TEST_USER);
  const blocks = formatMasteryBlocks(snapshot);
  const dueBlock = blocks.find((b) => b.text?.text?.includes('Due for review'));
  assert(dueBlock === undefined, 'no due-for-review block when nothing overdue');
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

header('8. Cleanup');
await cleanup();

// ── Result ───────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.error(`❌ ${failures} ASSERTION(S) FAILED`);
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED');
}
console.log('='.repeat(60));
