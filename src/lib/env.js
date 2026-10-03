import dotenv from 'dotenv';

// Tests run with NODE_ENV=test and stub credentials; never let a local .env override them.
// SKIP_DOTENV covers test-spawned children that boot with another NODE_ENV (e.g. production).
if (process.env.NODE_ENV !== 'test' && !process.env.SKIP_DOTENV) {
  dotenv.config({ override: true });
}
