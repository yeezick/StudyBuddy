// The Postgres tests take their database from the standard libpq variables (PGHOST, PGPORT,
// PGDATABASE, PGUSER, PGPASSWORD), which node-postgres reads itself, so no connection URL is
// written anywhere. TEST_POSTGRES=1 opts in. Only a local host is accepted: a real database is
// never touched.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'];

export const testDbEnabled = (env = process.env) => env.TEST_POSTGRES === '1';

export function assertLocalTestDb(env = process.env) {
  const host = env.PGHOST || 'localhost';
  if (!LOCAL_HOSTS.includes(host) && !host.startsWith('/')) {
    throw new Error(`PGHOST must point at a local test database, got "${host}"`);
  }
}

// For children spawned with a minimal env.
export const pgEnv = (env = process.env) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => /^PG[A-Z]+$/.test(k)));
