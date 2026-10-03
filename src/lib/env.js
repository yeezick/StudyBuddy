import dotenv from 'dotenv';

// Tests run with NODE_ENV=test and stub credentials; never let a local .env override them.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ override: true });
}
