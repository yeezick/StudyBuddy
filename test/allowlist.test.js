import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slackUserIdOf, allowOnlyOwner } from '../src/slack/allowlist.js';
import { createBoltApp } from '../src/slack/app.js';

const commandBody = (user) => ({ command: '/mastery', user_id: user, channel_id: 'D1', text: '', team_id: 'T1' });
const actionBody = (user) => ({ type: 'block_actions', user: { id: user }, actions: [{ action_id: 'quiz_answer_A' }], team: { id: 'T1' } });
const messageBody = (user) => ({ type: 'event_callback', team_id: 'T1', event: { type: 'message', user, channel: 'D1', text: 'hi', channel_type: 'im' } });

test('slackUserIdOf reads commands, actions and events', () => {
  assert.equal(slackUserIdOf(commandBody('U1')), 'U1');
  assert.equal(slackUserIdOf(actionBody('U2')), 'U2');
  assert.equal(slackUserIdOf(messageBody('U3')), 'U3');
  assert.equal(slackUserIdOf({}), null);
});

test('S0-3: middleware passes the owner and acks-and-drops everyone else', async () => {
  let nexted = 0;
  let acked = 0;
  const next = async () => { nexted++; };
  const ack = async () => { acked++; };

  await allowOnlyOwner({ body: commandBody('UOWNER'), ack, next });
  assert.equal(nexted, 1);

  await allowOnlyOwner({ body: commandBody('USTRANGER'), ack, next });
  await allowOnlyOwner({ body: actionBody('USTRANGER'), ack, next });
  await allowOnlyOwner({ body: messageBody('USTRANGER'), next });
  assert.equal(nexted, 1, 'stranger never reaches a handler');
  assert.equal(acked, 2, 'command and action are acked so Slack shows no error');
});

test('S0-3: unset SLACK_USER_ID allows nobody', async () => {
  const saved = process.env.SLACK_USER_ID;
  delete process.env.SLACK_USER_ID;
  let nexted = 0;
  await allowOnlyOwner({ body: commandBody(undefined), ack: async () => {}, next: async () => { nexted++; } });
  process.env.SLACK_USER_ID = saved;
  assert.equal(nexted, 0);
});

test('S0-3: a real Bolt app runs handlers only for the owner', async () => {
  const app = createBoltApp({
    signingSecret: 'test-signing-secret',
    authorize: async () => ({ botToken: 'xoxb-test', botId: 'B1', botUserId: 'UBOT' }),
  });
  const seen = [];
  app.command('/mastery', async ({ ack, command }) => { await ack(); seen.push(`command:${command.user_id}`); });
  app.action('quiz_answer_A', async ({ ack, body }) => { await ack(); seen.push(`action:${body.user.id}`); });
  app.message(async ({ message }) => { seen.push(`message:${message.user}`); });

  for (const user of ['USTRANGER', 'UOWNER']) {
    await app.processEvent({ body: commandBody(user), ack: async () => {} });
    await app.processEvent({ body: actionBody(user), ack: async () => {} });
    await app.processEvent({ body: messageBody(user), ack: async () => {} });
  }
  assert.deepEqual(seen.sort(), ['action:UOWNER', 'command:UOWNER', 'message:UOWNER']);
});
