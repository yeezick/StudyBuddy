// In-memory stand-in for Upstash: intercepts the REST calls @upstash/redis makes via fetch,
// so src/redis.js runs unmodified. Only the commands the app uses are implemented.
const enc = (s) => Buffer.from(s, 'utf8').toString('base64');

// Upstash base64-decodes strings at any depth of an array result (SCAN nests its keys).
const encodeItem = (x) => (typeof x === 'string' ? enc(x) : Array.isArray(x) ? x.map(encodeItem) : x);

function encodeResult(v) {
  if (typeof v === 'string') return v === 'OK' ? v : enc(v);
  if (Array.isArray(v)) return v.map(encodeItem);
  return v;
}

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

// Redis range semantics: inclusive stop, negative indexes count from the end.
function range(list, start, stop) {
  const at = (i) => (Number(i) < 0 ? list.length + Number(i) : Number(i));
  return list.slice(Math.max(at(start), 0), at(stop) + 1);
}

export function stubRedis() {
  const store = new Map();
  const lists = new Map();
  const commands = {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); return 'OK'; },
    del: (...ks) => ks.reduce((n, k) => n + (store.delete(k) || lists.delete(k) ? 1 : 0), 0),
    mget: (...ks) => ks.map((k) => store.get(k) ?? null),
    lpush: (k, ...vs) => {
      const list = lists.get(k) ?? [];
      for (const v of vs) list.unshift(v);
      lists.set(k, list);
      return list.length;
    },
    ltrim: (k, start, stop) => { lists.set(k, range(lists.get(k) ?? [], start, stop)); return 'OK'; },
    lrange: (k, start, stop) => range(lists.get(k) ?? [], start, stop),
    // One page holds everything; the cursor is always '0'.
    scan: (_cursor, ...opts) => {
      const i = opts.findIndex((o) => o.toLowerCase() === 'match');
      const re = globToRegExp(i === -1 ? '*' : opts[i + 1]);
      return ['0', [...store.keys(), ...lists.keys()].filter((k) => re.test(k))];
    },
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
