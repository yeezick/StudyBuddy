import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeMessage } from '../src/slack/messageRouter.js';
import { isBreakMessage } from '../src/slack/sessionFlow.js';

const msg = (text, extra = {}) => ({ user: 'UOWNER', channel: 'D1', text, ...extra });
const pending = (quiz, session) => ({ hasQuizReply: () => quiz, hasSessionReply: () => session });

// Free-text answers that happen to contain break/pause/N-min wording.
const ANSWERS = [
  'You pause the pipeline, then retry after a 10 min backoff',
  'Take a break from the cache and hit the DB directly',
  'Batch jobs run every 5 minutes',
];

test('S0-9: free-text quiz answers never trigger break detection', () => {
  for (const text of ANSWERS) {
    assert.ok(isBreakMessage(text), `fixture would have matched the old listener: ${text}`);
    assert.equal(routeMessage(msg(text), pending(true, false)), 'quiz');
    assert.equal(routeMessage(msg(text), pending(true, true)), 'quiz');
  }
});

test('S0-9: pending session reply wins over break detection', () => {
  assert.equal(routeMessage(msg('the key idea is a 5 min break'), pending(false, true)), 'session');
});

test('break detection still fires when nothing is waiting for a reply', () => {
  assert.equal(routeMessage(msg('brb, 15 min break'), pending(false, false)), 'break');
  assert.equal(routeMessage(msg('ok thanks'), pending(false, false)), 'ignore');
});

test('message subtypes are ignored', () => {
  assert.equal(routeMessage(msg('pause', { subtype: 'message_changed' }), pending(true, true)), 'ignore');
});
