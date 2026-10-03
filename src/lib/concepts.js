import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redis } from '../redis.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const DEFAULT_SEED_PATH = path.join(REPO_ROOT, 'content', 'concepts-seed.example.json');

// SEED_PATH (absolute, or relative to the repo root) points at your own concept library.
// Unset → the bundled example seed.
function resolveSeedPath() {
  const configured = process.env.SEED_PATH;
  const seedPath = configured ? path.resolve(REPO_ROOT, configured) : DEFAULT_SEED_PATH;
  if (!fs.existsSync(seedPath)) {
    throw new Error(
      configured
        ? `SEED_PATH points to a missing file: ${seedPath}. Fix SEED_PATH or unset it to use the example seed.`
        : `Example seed not found at ${seedPath}. Set SEED_PATH to your concept library.`
    );
  }
  return seedPath;
}

export async function seedIfEmpty(userId) {
  const seedPath = resolveSeedPath();
  const key = `concepts:${userId}`;
  const existing = await redis.get(key);
  if (existing) {
    console.log(`Concepts already seeded for ${userId}, skipping`);
    return { seeded: false, count: 0 };
  }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  await redis.set(key, JSON.stringify(seed));
  console.log(`Seeded ${seed.length} concepts for ${userId} from ${path.relative(REPO_ROOT, seedPath)}`);
  return { seeded: true, count: seed.length };
}

export async function getConcepts(userId, { module: moduleFilter, lesson } = {}) {
  const raw = await redis.get(`concepts:${userId}`);
  if (!raw) return [];
  const concepts = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!moduleFilter && !lesson) return concepts;
  return concepts.filter((c) => {
    if (moduleFilter && c.scope?.module !== moduleFilter) return false;
    if (lesson && c.scope?.lesson !== lesson) return false;
    return true;
  });
}
