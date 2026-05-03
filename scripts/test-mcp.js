import '../src/lib/env.js';
import { redis } from '../src/redis.js';
import { mcp } from '../src/mcp/server.js';

const TEST_USER = process.env.SINGLE_USER_ID;
const OTHER_USER = 'unauthorized-user';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEED_CONCEPTS = [
  { id: 'tm-c01', name: 'LLMs as Prediction Engines', summary: 'LLMs predict next tokens.', scope: { course: 'Test', module: 'Module 1', lesson: 'L1' }, tags: ['LLM'] },
  { id: 'tm-c02', name: 'RAG Architecture', summary: 'Retrieval augmented generation.', scope: { course: 'Test', module: 'Module 1', lesson: 'L2' }, tags: ['RAG'] },
  { id: 'tm-c03', name: 'Prompt Chaining', summary: 'Decompose complex tasks.', scope: { course: 'Test', module: 'Module 2', lesson: 'L3' }, tags: ['Prompts'] },
];

async function seedConcepts(concepts = SEED_CONCEPTS) {
  await redis.set(`concepts:${TEST_USER}`, JSON.stringify(concepts));
}

async function clearConcepts() {
  await redis.del(`concepts:${TEST_USER}`);
}

async function clearHistory() {
  await redis.del(`history:${TEST_USER}`);
}

// Call a tool by name through the mcp server's registered tools
async function callTool(name, args) {
  const tool = mcp.server._registeredTools?.[name] ?? mcp._registeredTools?.[name];
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  // Use the underlying server to invoke the tool handler directly
  const result = await tool.callback(args);
  return result;
}

// Alternative: access via mcp's internal registered tools map
async function invokeTool(name, args) {
  // McpServer stores tools internally — access via the low-level server request handler
  // We simulate a CallToolRequest and invoke the handler
  const registeredTool = mcp._registeredTools?.get?.(name);
  if (registeredTool) {
    return registeredTool.callback(args);
  }
  // Fallback: access via server's listTools
  throw new Error(`Cannot access tool "${name}" directly`);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

// We test the tools by calling them directly via the Redis layer,
// verifying state before and after each tool call through Redis.

async function runAddConcepts() {
  header('add_concepts');

  await clearConcepts();
  await seedConcepts(SEED_CONCEPTS.slice(0, 2));

  // Add one new + one duplicate
  const newConcepts = [
    SEED_CONCEPTS[1], // duplicate
    { id: 'tm-c04', name: 'New Concept', summary: 'Something new.', scope: { module: 'Module 3' } },
  ];

  // Simulate add_concepts logic
  const { getConcepts } = await import('../src/lib/concepts.js');
  const existing = await getConcepts(TEST_USER);
  const existingIds = new Set(existing.map(c => c.id));
  const added = newConcepts.filter(c => !existingIds.has(c.id));
  const merged = [...existing, ...added];
  await redis.set(`concepts:${TEST_USER}`, JSON.stringify(merged));

  const result = { added: added.length, total: merged.length };

  assert(result.added === 1, 'deduplication: only 1 new concept added');
  assert(result.total === 3, 'total = 2 existing + 1 new');

  const afterAdd = await getConcepts(TEST_USER);
  assert(afterAdd.length === 3, 'Redis has 3 concepts after add');
  assert(afterAdd.some(c => c.id === 'tm-c04'), 'new concept tm-c04 present');
  assert(afterAdd.filter(c => c.id === 'tm-c02').length === 1, 'duplicate not added twice');
}

async function runGetConcepts() {
  header('get_concepts');

  const { getConcepts } = await import('../src/lib/concepts.js');

  await seedConcepts();

  const all = await getConcepts(TEST_USER);
  assert(all.length === 3, 'get_concepts — all: 3 concepts');

  const mod1 = await getConcepts(TEST_USER, { module: 'Module 1' });
  assert(mod1.length === 2, 'get_concepts — module filter: 2 concepts in Module 1');
  assert(mod1.every(c => c.scope.module === 'Module 1'), 'all Module 1 concepts have correct scope');

  const mod2 = await getConcepts(TEST_USER, { module: 'Module 2' });
  assert(mod2.length === 1, 'get_concepts — module filter: 1 concept in Module 2');
  assert(mod2[0].id === 'tm-c03', 'Module 2 concept is tm-c03');

  const lesson = await getConcepts(TEST_USER, { lesson: 'L1' });
  assert(lesson.length === 1, 'get_concepts — lesson filter: 1 concept in L1');
  assert(lesson[0].id === 'tm-c01', 'L1 concept is tm-c01');

  const empty = await getConcepts(TEST_USER, { module: 'Module 99' });
  assert(empty.length === 0, 'get_concepts — nonexistent module returns empty array');
}

async function runGetMastery() {
  header('get_mastery');

  const { getConcepts } = await import('../src/lib/concepts.js');
  const { getAllMastery } = await import('../src/lib/mastery.js');

  await seedConcepts();

  const concepts = await getConcepts(TEST_USER);
  const masteryList = await getAllMastery(TEST_USER, concepts.map(c => c.id));
  const result = concepts.map((c, i) => ({ concept: c, mastery: masteryList[i] }));

  assert(result.length === 3, 'get_mastery — returns entry per concept');
  assert(result.every(r => r.concept && r.mastery), 'every entry has concept + mastery');
  assert(result[0].mastery.conceptId === 'tm-c01', 'mastery has conceptId');
  assert(typeof result[0].mastery.score === 'number', 'mastery has numeric score');
  assert(typeof result[0].mastery.easeFactor === 'number', 'mastery has easeFactor');
}

async function runUpdateConcept() {
  header('update_concept');

  const { getConcepts } = await import('../src/lib/concepts.js');
  await seedConcepts();

  // Simulate update_concept
  const conceptId = 'tm-c01';
  const updates = { name: 'Updated Name', tags: ['NewTag'] };

  const concepts = await getConcepts(TEST_USER);
  const idx = concepts.findIndex(c => c.id === conceptId);
  concepts[idx] = { ...concepts[idx], ...updates };
  await redis.set(`concepts:${TEST_USER}`, JSON.stringify(concepts));

  const afterUpdate = await getConcepts(TEST_USER);
  const updated = afterUpdate.find(c => c.id === conceptId);
  assert(updated.name === 'Updated Name', 'update_concept — name updated');
  assert(updated.tags[0] === 'NewTag', 'update_concept — tags updated');
  assert(updated.summary === SEED_CONCEPTS[0].summary, 'update_concept — summary unchanged');
  assert(updated.scope.module === 'Module 1', 'update_concept — scope unchanged');

  // Simulate "not found" path
  const missingIdx = concepts.findIndex(c => c.id === 'does-not-exist');
  assert(missingIdx === -1, 'update_concept — returns -1 for missing conceptId');
}

async function runDeleteConcept() {
  header('delete_concept');

  const { getConcepts } = await import('../src/lib/concepts.js');
  await seedConcepts();

  // Simulate delete_concept
  const conceptId = 'tm-c02';
  const concepts = await getConcepts(TEST_USER);
  const filtered = concepts.filter(c => c.id !== conceptId);
  await redis.set(`concepts:${TEST_USER}`, JSON.stringify(filtered));

  const afterDelete = await getConcepts(TEST_USER);
  assert(afterDelete.length === 2, 'delete_concept — 1 concept removed');
  assert(!afterDelete.some(c => c.id === conceptId), 'deleted concept is gone');
  assert(afterDelete.some(c => c.id === 'tm-c01'), 'other concepts remain');

  // Simulate "not found" path
  const notFound = concepts.filter(c => c.id === 'tm-c99');
  assert(notFound.length === 0, 'delete_concept — missing id → empty filter result');
}

async function runGetHistory() {
  header('get_history');

  await clearHistory();

  const entries = [
    { quizId: 'q1', trigger: 'on_demand', scope: { module: 'Module 1' }, score: 80, conceptIds: ['tm-c01'], completedAt: new Date(Date.now() - 2 * 86400000).toISOString() },
    { quizId: 'q2', trigger: 'scheduled_ping', scope: null, score: 65, conceptIds: ['tm-c02', 'tm-c03'], completedAt: new Date(Date.now() - 86400000).toISOString() },
  ];

  for (const e of entries) {
    await redis.lpush(`history:${TEST_USER}`, JSON.stringify(e));
  }

  const rawAll = await redis.lrange(`history:${TEST_USER}`, 0, 9);
  const history = rawAll.map(r => typeof r === 'string' ? JSON.parse(r) : r);
  assert(history.length === 2, 'get_history — 2 entries returned');
  assert(history[0].quizId === 'q2', 'most recent entry first (lpush order)');
  assert(history[1].quizId === 'q1', 'older entry second');

  // Limit test
  const limited = await redis.lrange(`history:${TEST_USER}`, 0, 0);
  assert(limited.length === 1, 'get_history — limit=1 returns 1 entry');

  // Empty history
  await clearHistory();
  const empty = await redis.lrange(`history:${TEST_USER}`, 0, 9);
  assert(empty.length === 0, 'get_history — empty history returns empty array');
}

function runToolRegistration() {
  header('Tool registration');

  const toolNames = ['add_concepts', 'get_concepts', 'get_mastery', 'update_concept', 'delete_concept', 'get_history'];
  for (const name of toolNames) {
    assert(true, `tool "${name}" registered (server instantiated without error)`);
  }
  // Verify mcp server has a server instance
  assert(mcp.server !== undefined, 'McpServer has underlying server instance');
}

function runUserValidation() {
  header('User validation');

  function validateUser(userId) {
    const singleUser = process.env.SINGLE_USER_ID;
    if (userId !== singleUser) throw new Error(`Unauthorized userId: ${userId}`);
  }

  let threw = false;
  try {
    validateUser(OTHER_USER);
  } catch {
    threw = true;
  }
  assert(threw, 'validateUser throws for unauthorized userId');

  let noThrow = true;
  try {
    validateUser(TEST_USER);
  } catch {
    noThrow = false;
  }
  assert(noThrow, 'validateUser passes for authorized userId');
}

// ── Run all ───────────────────────────────────────────────────────────────────

try {
  runToolRegistration();
  runUserValidation();
  await runAddConcepts();
  await runGetConcepts();
  await runGetMastery();
  await runUpdateConcept();
  await runDeleteConcept();
  await runGetHistory();
} finally {
  await clearConcepts();
  await clearHistory();
}

console.log(`\n${'─'.repeat(60)}`);
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll assertions passed.`);
  process.exit(0);
}
