import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redis } from '../redis.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const SEED_PATH = path.join(REPO_ROOT, 'concepts-seed.json');

export async function seedIfEmpty(userId) {
  const key = `concepts:${userId}`;
  const existing = await redis.get(key);
  if (existing) {
    console.log(`Concepts already seeded for ${userId}, skipping`);
    return { seeded: false, count: 0 };
  }
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  await redis.set(key, JSON.stringify(seed));
  console.log(`Seeded ${seed.length} concepts for ${userId}`);
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
