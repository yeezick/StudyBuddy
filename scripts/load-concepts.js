// Replaces a deployment's concept library with a seed file, through the authenticated MCP endpoint.
//
//   SEED_PATH=private/content/concepts-seed.json MCP_URL=https://<host>/mcp/sse \
//   MCP_AUTH_TOKEN=... SINGLE_USER_ID=... node scripts/load-concepts.js [--dry-run]
//
// --dry-run prints what would be added, changed and removed, and writes nothing.
// Re-running is safe: every run recomputes the diff against what the server holds.
import '../src/lib/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { diffConcepts } from '../src/mcp/conceptOps.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sseUrl(raw) {
  const url = new URL(raw);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp/sse';
  return url;
}

export async function connectMcp(url, token) {
  const transport = new SSEClientTransport(sseUrl(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'studybuddy-load-concepts', version: '0.1.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    await client.close(); // otherwise the EventSource keeps retrying and the process never exits
    throw err;
  }
  return client;
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

function printPlan({ add, change, remove, unchanged }, log) {
  log(`add ${add.length} · change ${change.length} · remove ${remove.length} · unchanged ${unchanged.length}`);
  for (const c of add) log(`  + ${c.id}  ${c.name}`);
  for (const c of change) log(`  ~ ${c.id}  ${c.name}`);
  for (const c of remove) log(`  - ${c.id}  ${c.name}`);
}

export async function loadConcepts({ client, userId, seed, dryRun = false, log = console.log }) {
  const existing = await callTool(client, 'get_concepts', { userId });
  const plan = diffConcepts(existing, seed);
  printPlan(plan, log);
  if (dryRun) {
    log('dry run: nothing written');
    return plan;
  }

  // New concepts first, so a failed run never leaves the library emptier than it started.
  if (plan.add.length) await callTool(client, 'add_concepts', { userId, concepts: plan.add });
  // add_concepts skips ids that exist, so a changed concept is deleted and re-added.
  // Mastery is stored per concept id, so it survives this.
  for (const c of plan.change) {
    await callTool(client, 'delete_concept', { userId, conceptId: c.id });
    await callTool(client, 'add_concepts', { userId, concepts: [c] });
  }
  for (const c of plan.remove) await callTool(client, 'delete_concept', { userId, conceptId: c.id });

  const after = diffConcepts(await callTool(client, 'get_concepts', { userId }), seed);
  const left = after.add.length + after.change.length + after.remove.length;
  if (left) throw new Error(`library still differs from the seed after loading (${left} concepts)`);
  log(`done: library matches the seed (${seed.length} concepts)`);
  return plan;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const seedPath = path.resolve(REPO_ROOT, requireEnv('SEED_PATH'));
  const url = requireEnv('MCP_URL');
  const token = requireEnv('MCP_AUTH_TOKEN');
  const userId = requireEnv('SINGLE_USER_ID');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  console.log(`seed: ${path.relative(REPO_ROOT, seedPath)} (${seed.length} concepts) → ${sseUrl(url).origin}`);
  const client = await connectMcp(url, token);
  try {
    await loadConcepts({ client, userId, seed, dryRun });
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[load-concepts] ${err.message}`);
    process.exit(1);
  });
}
