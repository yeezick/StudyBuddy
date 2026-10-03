// Dependency states reported by GET /health. Boot and the scheduler update these;
// /health only reads them, so it never waits on a slow dependency.
const deps = new Map();

export function setDep(name, state, detail = null) {
  deps.set(name, { state, detail, since: new Date().toISOString() });
}

export function depSnapshot() {
  return Object.fromEntries(deps);
}

// Runs a boot step in the background, recording its outcome instead of throwing.
export async function track(name, fn) {
  setDep(name, 'starting');
  try {
    const result = await fn();
    setDep(name, 'ok');
    return result;
  } catch (err) {
    setDep(name, 'error', err.message);
    console.error(`[boot] ${name} failed | ${err.message}`);
    return undefined;
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
