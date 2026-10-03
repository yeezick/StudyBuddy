import './helpers/env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stubRedis } from './helpers/fakeRedis.js';
import { seedIfEmpty } from '../src/lib/concepts.js';

let fake;
beforeEach(() => { fake = stubRedis(); delete process.env.SEED_PATH; });
afterEach(() => fake.restore());

const EXAMPLE = JSON.parse(fs.readFileSync(new URL('../content/concepts-seed.example.json', import.meta.url)));

test('SEED_PATH unset → example seed is loaded', async () => {
  const result = await seedIfEmpty('u1');
  assert.deepEqual(result, { seeded: true, count: EXAMPLE.length });
  assert.equal(JSON.parse(fake.store.get('concepts:u1')).length, EXAMPLE.length);
});

test('already seeded → skipped', async () => {
  fake.store.set('concepts:u1', '[]x');
  assert.deepEqual(await seedIfEmpty('u1'), { seeded: false, count: 0 });
});

test('missing SEED_PATH file → error naming the variable', async () => {
  process.env.SEED_PATH = 'does/not/exist.json';
  await assert.rejects(seedIfEmpty('u1'), /SEED_PATH points to a missing file/);
});
