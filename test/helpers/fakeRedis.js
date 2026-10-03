// In-memory stand-in for Upstash: intercepts the REST calls @upstash/redis makes via fetch,
// so src/redis.js runs unmodified. Only the commands the app uses are implemented.
const enc = (s) => Buffer.from(s, 'utf8').toString('base64');

function encodeResult(v) {
  if (typeof v === 'string') return v === 'OK' ? v : enc(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? enc(x) : x));
  return v;
}

export function stubRedis() {
  const store = new Map();
  const lists = new Map();
  const commands = {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); return 'OK'; },
    del: (...ks) => ks.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
    mget: (...ks) => ks.map((k) => store.get(k) ?? null),
    lrange: (k, start, stop) => (lists.get(k) ?? []).slice(Number(start), Number(stop) + 1),
    ping: () => 'PONG',
  };
  const run = ([name, ...args]) => {
    const fn = commands[name.toLowerCase()];
    if (!fn) return { error: `fakeRedis: unsupported command ${name}` };
    return { result: encodeResult(fn(...args.map(String))) };
  };

  const realFetch = globalThis.fetch;
  const base = process.env.UPSTASH_REDIS_REST_URL;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(base)) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const payload = String(url).endsWith('/pipeline') ? body.map(run) : run(body);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return {
    store,
    lists,
    restore() { globalThis.fetch = realFetch; },
  };
}
