import crypto from 'node:crypto';

// Shared-secret guard for HTTP routes that must not be public (/mcp/*).
// Expects `Authorization: Bearer <MCP_AUTH_TOKEN>`. Unset token → every request is rejected.
export function requireBearer(getToken = () => process.env.MCP_AUTH_TOKEN) {
  return (req, res, next) => {
    const expected = getToken();
    const match = (req.get('authorization') ?? '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!expected || !match || !safeEqual(match[1], expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

// Hash first so timingSafeEqual gets equal-length buffers and length isn't leaked.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Production must never expose /mcp without a secret: refuse to boot.
export function assertMcpAuthConfigured(env = process.env) {
  if (env.MCP_AUTH_TOKEN) return;
  if (env.NODE_ENV === 'production') {
    throw new Error('Missing MCP_AUTH_TOKEN. Refusing to start in production with an unauthenticated /mcp endpoint.');
  }
  console.warn('[mcp] MCP_AUTH_TOKEN is unset — every /mcp request will get 401.');
}
