import { TEST_ENV } from './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveUser, slackUserIdFor, isKnownUser, bootUserIds } from '../src/lib/resolveUser.js';
import { allowOnlyOwner } from '../src/slack/allowlist.js';

const OWNER = { userId: TEST_ENV.SINGLE_USER_ID, slackUserId: TEST_ENV.SLACK_USER_ID };

test('T1-1: resolveUser maps the owner from commands, actions, events and bare ids', () => {
  const expected = { userId: OWNER.userId, slackUserId: OWNER.slackUserId };
  assert.deepEqual(resolveUser({ user_id: 'UOWNER' }), expected);
  assert.deepEqual(resolveUser({ user: { id: 'UOWNER' } }), expected);
  assert.deepEqual(resolveUser({ event: { user: 'UOWNER' } }), expected);
  assert.deepEqual(resolveUser('UOWNER'), expected);
});

test('T1-1: resolveUser returns null for strangers, missing ids and an unconfigured owner', () => {
  assert.equal(resolveUser({ user_id: 'USTRANGER' }), null);
  assert.equal(resolveUser({}), null);
  assert.equal(resolveUser(undefined), null);
  assert.equal(resolveUser('UOWNER', { userId: null, slackUserId: 'UOWNER' }), null);
  assert.equal(resolveUser(undefined, { userId: 'u', slackUserId: null }), null);
});

test('T1-1: reverse lookup, known-user check and boot users', () => {
  assert.equal(slackUserIdFor(OWNER.userId), OWNER.slackUserId);
  assert.equal(slackUserIdFor('someone-else'), null);
  assert.equal(isKnownUser(OWNER.userId), true);
  assert.equal(isKnownUser('someone-else'), false);
  assert.equal(isKnownUser(undefined, { userId: null }), false);
  assert.deepEqual(bootUserIds(), [OWNER.userId]);
  assert.deepEqual(bootUserIds({ userId: null }), []);
});

test('T1-1: the Slack middleware hands handlers the resolved user', async () => {
  const context = {};
  let nexted = false;
  await allowOnlyOwner({ body: { user_id: 'UOWNER' }, context, ack: async () => {}, next: async () => { nexted = true; } });
  assert.equal(nexted, true);
  assert.equal(context.userId, OWNER.userId);
});

// Acceptance guard: only config.js reads the owner env vars.
test('T1-1: no SINGLE_USER_ID / SLACK_USER_ID reads in src outside config.js', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.js'));
  const offenders = files
    .filter((f) => path.normalize(f) !== path.join('lib', 'config.js'))
    .filter((f) => /process\.env\.(SINGLE_USER_ID|SLACK_USER_ID)|env\.(SINGLE_USER_ID|SLACK_USER_ID)|'(SINGLE_USER_ID|SLACK_USER_ID)'/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(offenders, []);
});
