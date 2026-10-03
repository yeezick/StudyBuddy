// cobrain:secret-fixtures — every value below is a fake placeholder for offline tests.
// Stub credentials for offline tests. Import this first in every test file.
// Nothing here is real: Redis/Upstash point at a closed local port, Slack/Anthropic tokens are fake.
export const TEST_ENV = {
  NODE_ENV: 'test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'test-signing-secret',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_USER_ID: 'UOWNER',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1',
  UPSTASH_REDIS_REST_TOKEN: 'test',
  REDIS_URL: 'redis://127.0.0.1:1',
  SINGLE_USER_ID: 'test-user',
  USER_TIMEZONE: 'America/Chicago',
  MCP_AUTH_TOKEN: 'test-mcp-token',
  SEED_PATH: '',
  SKIP_DOTENV: '1', // spawned children must never load the developer's real .env
};

Object.assign(process.env, TEST_ENV);
