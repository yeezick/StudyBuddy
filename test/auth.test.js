import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireBearer, assertMcpAuthConfigured } from '../src/lib/auth.js';

async function withServer(token, fn) {
  const app = express();
  app.get('/mcp/sse', requireBearer(() => token), (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/mcp/sse`);
  } finally {
    server.close();
  }
}

test('S0-1: /mcp rejects missing or wrong bearer token with 401', async () => {
  await withServer('s3cret', async (url) => {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 's3cret' } })).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer s3cret' } })).status, 200);
  });
});

test('S0-1: unset token rejects every request', async () => {
  await withServer(undefined, async (url) => {
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer anything' } })).status, 401);
  });
});

test('S0-1: production refuses to boot without MCP_AUTH_TOKEN', () => {
  assert.throws(() => assertMcpAuthConfigured({ NODE_ENV: 'production' }), /MCP_AUTH_TOKEN/);
  assert.doesNotThrow(() => assertMcpAuthConfigured({ NODE_ENV: 'production', MCP_AUTH_TOKEN: 'x' }));
  assert.doesNotThrow(() => assertMcpAuthConfigured({ NODE_ENV: 'development' }));
});
