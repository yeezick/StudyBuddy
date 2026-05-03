import '../src/lib/env.js';
import { redis } from '../src/redis.js';
import {
  defaultMastery,
  updateMastery,
  qualityScoreFromMCQ,
  qualityScoreFromFreeText,
} from '../src/lib/sm2.js';
import {
  getMastery,
  setMastery,
  getAllMastery,
  applyQuestionResult,
} from '../src/lib/mastery.js';

const TEST_USER = 'test-sm2-temp';

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

function approxEq(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

function daysBetween(isoDate) {
  const ms = new Date(isoDate).getTime() - Date.now();
  return ms / (1000 * 60 * 60 * 24);
}

function testAlgorithm() {
  header('1. SM-2 algorithm correctness');

  const seed = defaultMastery('m1-c01');
  assert(seed.easeFactor === 2.5, 'default EF = 2.5');
  assert(seed.interval === 1, 'default interval = 1');
  assert(seed.repetitions === 0, 'default repetitions = 0');

  // Wrong answer (q=1) — EF decreases so failed concepts get shorter intervals and lower mastery
  const wrong = updateMastery(seed, 1);
  assert(wrong.repetitions === 0, 'wrong: repetitions reset to 0');
  assert(wrong.interval === 1, 'wrong: interval = 1');
  assert(approxEq(wrong.easeFactor, 1.96, 0.001), `wrong: EF decreased to ~1.96 (got ${wrong.easeFactor})`);
  assert(approxEq(daysBetween(wrong.nextReviewAt), 1, 0.05), 'wrong: nextReviewAt ≈ +1d');

  // q=5 on default
  const r1 = updateMastery(seed, 5);
  assert(r1.repetitions === 1, 'q=5 #1: repetitions = 1');
  assert(r1.interval === 1, 'q=5 #1: interval = 1');
  assert(approxEq(r1.easeFactor, 2.6), `q=5 #1: EF ≈ 2.6 (got ${r1.easeFactor.toFixed(3)})`);
  assert(approxEq(r1.score, 0.15), `q=5 #1: score = 0.15 (got ${r1.score})`);

  // q=4 second
  const r2 = updateMastery(r1, 4);
  assert(r2.repetitions === 2, 'q=4 #2: repetitions = 2');
  assert(r2.interval === 6, 'q=4 #2: interval = 6');
  assert(approxEq(r2.score, 0.30), `q=4 #2: score = 0.30 (got ${r2.score})`);

  // q=4 third
  const r3 = updateMastery(r2, 4);
  assert(r3.repetitions === 3, 'q=4 #3: repetitions = 3');
  const expectedInterval = Math.round(6 * r2.easeFactor);
  assert(r3.interval === expectedInterval, `q=4 #3: interval = round(6 * ${r2.easeFactor.toFixed(3)}) = ${expectedInterval}`);
  assert(approxEq(daysBetween(r3.nextReviewAt), expectedInterval, 0.05), `q=4 #3: nextReviewAt ≈ +${expectedInterval}d`);
  assert(approxEq(r3.score, 0.45), `q=4 #3: score = 0.45 (got ${r3.score})`);

  // EF floor at 1.3 — must alternate q=3 (passes, applies the formula) to actually drive EF down
  let driven = seed;
  for (let i = 0; i < 20; i++) driven = updateMastery(driven, 3);
  assert(driven.easeFactor >= 1.3, `EF floor honored (${driven.easeFactor.toFixed(3)})`);
  assert(approxEq(driven.easeFactor, 1.3, 0.001), `EF clamps to 1.3 with sustained q=3 (got ${driven.easeFactor.toFixed(3)})`);

  // Score capped at 1.0 — 7 iterations of q=5 gets repetitions=7 → score=min(1, 1.05)=1.0
  let highRep = seed;
  for (let i = 0; i < 7; i++) highRep = updateMastery(highRep, 5);
  assert(highRep.score === 1.0, `score capped at 1.0 after ${highRep.repetitions} reps (got ${highRep.score})`);
}

function testQualityScores() {
  header('2. Quality score mapping');

  assert(qualityScoreFromMCQ(false, 3) === 1, 'MCQ wrong → 1');
  assert(qualityScoreFromMCQ(true, 1) === 3, 'MCQ correct + Low → 3');
  assert(qualityScoreFromMCQ(true, 2) === 4, 'MCQ correct + Med → 4');
  assert(qualityScoreFromMCQ(true, 3) === 5, 'MCQ correct + High → 5');

  assert(qualityScoreFromFreeText(0.8, 2) === 4, 'free-text 0.8 + Med → 4');
  assert(qualityScoreFromFreeText(0.8, 1) === 3, 'free-text 0.8 + Low → 3 (−1)');
  assert(qualityScoreFromFreeText(1.0, 3) === 5, 'free-text 1.0 + High → 5');
  assert(qualityScoreFromFreeText(0.0, 1) === 0, 'free-text 0.0 + Low → 0 (clamped)');
  assert(qualityScoreFromFreeText(0.5, 2) === 2, 'free-text 0.5 + Med → 2');
}

async function testPersistence() {
  header('3. Mastery Redis round-trip');

  const conceptId = 'test-concept-A';

  const initial = await getMastery(TEST_USER, conceptId);
  assert(initial.conceptId === conceptId, 'getMastery(missing) returns default with correct id');
  assert(initial.repetitions === 0, 'getMastery(missing) returns default repetitions=0');

  const updated = await applyQuestionResult(TEST_USER, conceptId, 5);
  assert(updated.repetitions === 1, 'applyQuestionResult: repetitions=1 after q=5');

  const reloaded = await getMastery(TEST_USER, conceptId);
  assert(reloaded.repetitions === 1, 'reloaded from Redis: repetitions=1');
  assert(approxEq(reloaded.easeFactor, updated.easeFactor), 'reloaded: EF matches');
  assert(reloaded.lastReviewedAt === updated.lastReviewedAt, 'reloaded: lastReviewedAt matches');

  // Apply a second time
  const second = await applyQuestionResult(TEST_USER, conceptId, 4);
  assert(second.repetitions === 2, 'second apply: repetitions=2');
  assert(second.interval === 6, 'second apply: interval=6');
}

async function testBatchRead() {
  header('4. Batch mastery read (existing + missing)');

  const ids = ['test-concept-A', 'test-concept-B', 'test-concept-C'];
  // Pre-seed B
  await setMastery(TEST_USER, { ...defaultMastery('test-concept-B'), repetitions: 7 });

  const results = await getAllMastery(TEST_USER, ids);
  assert(results.length === 3, 'returns 3 results for 3 ids');
  assert(results[0].conceptId === 'test-concept-A', 'order preserved [0]');
  assert(results[1].conceptId === 'test-concept-B' && results[1].repetitions === 7, 'B has stored value');
  assert(results[2].conceptId === 'test-concept-C' && results[2].repetitions === 0, 'C returns default (missing key)');

  const empty = await getAllMastery(TEST_USER, []);
  assert(Array.isArray(empty) && empty.length === 0, 'empty input → empty array');
}

async function cleanup() {
  header('5. Cleanup');
  const ids = ['test-concept-A', 'test-concept-B', 'test-concept-C'];
  const keys = ids.map((id) => `mastery:${TEST_USER}:${id}`);
  const deleted = await redis.del(...keys);
  console.log(`  deleted ${deleted} test keys`);
}

async function main() {
  testAlgorithm();
  testQualityScores();
  await testPersistence();
  await testBatchRead();
  await cleanup();

  header(failures ? `❌ ${failures} ASSERTION(S) FAILED` : '✅ ALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
