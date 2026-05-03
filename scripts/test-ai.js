import '../src/lib/env.js';
import { getConcepts } from '../src/lib/concepts.js';
import { generateQuestions } from '../src/ai/questionGen.js';
import { gradeMCQ, gradeFreeText } from '../src/ai/grading.js';
import { matchConceptsToPrompt } from '../src/ai/conceptMatch.js';

const userId = process.env.SINGLE_USER_ID || 'erick';

function header(label) {
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ❌ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function testQuestionGen(concepts) {
  header('1. questionGen — 3 mixed-type questions on Module 2');
  const m2 = concepts.filter((c) => c.scope?.module === 'Module 2');
  const questions = await generateQuestions({
    concepts: m2.slice(0, 8),
    count: 3,
    distribution: { mcq: 0.6, short_answer: 0.2, explain: 0.2 },
  });
  console.log(JSON.stringify(questions, null, 2));
  assert(Array.isArray(questions) && questions.length === 3, 'returned 3 questions');
  for (const q of questions) {
    assert(typeof q.conceptId === 'string', `conceptId on ${q.type}`);
    assert(['mcq', 'short_answer', 'explain', 'scenario'].includes(q.type), `valid type: ${q.type}`);
    assert(typeof q.prompt === 'string' && q.prompt.length > 0, 'has prompt');
    assert(typeof q.correctAnswer === 'string', 'has correctAnswer');
    assert(typeof q.explanation === 'string', 'has explanation');
    if (q.type === 'mcq') {
      assert(Array.isArray(q.options) && q.options.length === 4, 'MCQ has 4 options');
    }
  }
  const conceptIds = questions.map((q) => q.conceptId);
  for (let i = 1; i < conceptIds.length; i++) {
    assert(conceptIds[i] !== conceptIds[i - 1], `interleaving at position ${i}`);
  }
  return questions;
}

async function testMCQGrading(questions) {
  header('2. grading — MCQ deterministic');
  const mcq = questions.find((q) => q.type === 'mcq');
  if (!mcq) {
    console.log('  (no MCQ in generated set, skipping)');
    return;
  }
  const correctLetter = mcq.correctAnswer.trim().toUpperCase().charAt(0);
  const wrongLetter = ['A', 'B', 'C', 'D'].find((l) => l !== correctLetter);

  const correct = gradeMCQ(mcq, correctLetter);
  console.log('  correct answer →', correct);
  assert(correct.isCorrect === true && correct.score === 1, 'correct answer scored 1');

  const wrong = gradeMCQ(mcq, wrongLetter);
  console.log('  wrong answer   →', wrong);
  assert(wrong.isCorrect === false && wrong.score === 0, 'wrong answer scored 0');
}

async function testFreeTextGrading(questions) {
  header('3. grading — free-text via AI');
  const freeText = questions.find((q) => q.type !== 'mcq');
  if (!freeText) {
    console.log('  (no free-text question in generated set, skipping)');
    return;
  }
  console.log('  Q:', freeText.prompt);
  console.log('  Expected:', freeText.correctAnswer);
  const sampleAnswer = freeText.correctAnswer;
  const result = await gradeFreeText(freeText, sampleAnswer);
  console.log('  result →', result);
  assert(typeof result.isCorrect === 'boolean', 'isCorrect is boolean');
  assert(typeof result.score === 'number' && result.score >= 0 && result.score <= 1, 'score in [0,1]');
  assert(typeof result.feedback === 'string' && result.feedback.length > 0, 'has feedback');
}

async function testConceptMatch(concepts) {
  header('4. conceptMatch — "explain RAG failure modes"');
  const ids = await matchConceptsToPrompt('explain RAG failure modes', concepts);
  console.log('  matched IDs:', ids);
  console.log('  matched names:', ids.map((id) => concepts.find((c) => c.id === id)?.name));
  assert(Array.isArray(ids), 'returns array');
  assert(ids.length >= 5 && ids.length <= 10, `5–10 IDs (got ${ids.length})`);
  const validSet = new Set(concepts.map((c) => c.id));
  assert(ids.every((id) => validSet.has(id)), 'all IDs exist in seed');
}

async function main() {
  const concepts = await getConcepts(userId);
  if (concepts.length === 0) {
    console.error('No concepts in Redis. Run the server once to seed.');
    process.exit(1);
  }
  console.log(`Loaded ${concepts.length} concepts`);

  const questions = await testQuestionGen(concepts);
  await testMCQGrading(questions);
  await testFreeTextGrading(questions);
  await testConceptMatch(concepts);

  header(process.exitCode ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED');
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
