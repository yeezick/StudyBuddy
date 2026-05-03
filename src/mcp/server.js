import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { redis } from '../redis.js';
import { getConcepts } from '../lib/concepts.js';
import { getAllMastery } from '../lib/mastery.js';

function validateUser(userId) {
  const singleUser = process.env.SINGLE_USER_ID;
  if (userId !== singleUser) {
    throw new Error(`Unauthorized userId: ${userId}. This server is single-user.`);
  }
}

// ── MCP server ────────────────────────────────────────────────────────────────

export const mcp = new McpServer({ name: 'StudyAgent', version: '0.1.0' });

const conceptShape = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  scope: z.object({
    course: z.string().optional(),
    module: z.string().optional(),
    lesson: z.string().optional(),
  }).optional(),
  tags: z.array(z.string()).optional(),
});

// add_concepts
mcp.tool(
  'add_concepts',
  'Merges new concepts into the user\'s library. Deduplicates by concept.id. Returns count of added concepts.',
  {
    userId: z.string(),
    concepts: z.array(conceptShape),
  },
  async ({ userId, concepts }) => {
    validateUser(userId);
    const existing = await getConcepts(userId);
    const existingIds = new Set(existing.map((c) => c.id));
    const added = concepts.filter((c) => !existingIds.has(c.id));
    const merged = [...existing, ...added];
    await redis.set(`concepts:${userId}`, JSON.stringify(merged));
    return {
      content: [{ type: 'text', text: JSON.stringify({ added: added.length, total: merged.length }) }],
    };
  }
);

// get_concepts
mcp.tool(
  'get_concepts',
  'Returns all concepts for userId, optionally filtered by module or lesson scope.',
  {
    userId: z.string(),
    module: z.string().optional(),
    lesson: z.string().optional(),
  },
  async ({ userId, module: moduleFilter, lesson }) => {
    validateUser(userId);
    const concepts = await getConcepts(userId, { module: moduleFilter, lesson });
    return { content: [{ type: 'text', text: JSON.stringify(concepts) }] };
  }
);

// get_mastery
mcp.tool(
  'get_mastery',
  'Returns mastery state for all concepts, optionally filtered by module.',
  {
    userId: z.string(),
    module: z.string().optional(),
  },
  async ({ userId, module: moduleFilter }) => {
    validateUser(userId);
    const concepts = await getConcepts(userId, { module: moduleFilter });
    const masteryList = await getAllMastery(userId, concepts.map((c) => c.id));
    const result = concepts.map((c, i) => ({ concept: c, mastery: masteryList[i] }));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

// update_concept
mcp.tool(
  'update_concept',
  'Patch a single concept (name, summary, tags, or scope).',
  {
    userId: z.string(),
    conceptId: z.string(),
    updates: z.object({
      name: z.string().optional(),
      summary: z.string().optional(),
      tags: z.array(z.string()).optional(),
      scope: z.object({
        course: z.string().optional(),
        module: z.string().optional(),
        lesson: z.string().optional(),
      }).optional(),
    }),
  },
  async ({ userId, conceptId, updates }) => {
    validateUser(userId);
    const concepts = await getConcepts(userId);
    const idx = concepts.findIndex((c) => c.id === conceptId);
    if (idx === -1) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Concept ${conceptId} not found` }],
      };
    }
    concepts[idx] = { ...concepts[idx], ...updates };
    await redis.set(`concepts:${userId}`, JSON.stringify(concepts));
    return { content: [{ type: 'text', text: JSON.stringify(concepts[idx]) }] };
  }
);

// delete_concept
mcp.tool(
  'delete_concept',
  'Remove a concept from the library.',
  {
    userId: z.string(),
    conceptId: z.string(),
  },
  async ({ userId, conceptId }) => {
    validateUser(userId);
    const concepts = await getConcepts(userId);
    const filtered = concepts.filter((c) => c.id !== conceptId);
    if (filtered.length === concepts.length) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Concept ${conceptId} not found` }],
      };
    }
    await redis.set(`concepts:${userId}`, JSON.stringify(filtered));
    return {
      content: [{ type: 'text', text: JSON.stringify({ deleted: conceptId, remaining: filtered.length }) }],
    };
  }
);

// get_history
mcp.tool(
  'get_history',
  'Returns last N assessment summaries from the user\'s quiz history.',
  {
    userId: z.string(),
    limit: z.number().int().min(1).max(30).optional(),
  },
  async ({ userId, limit = 10 }) => {
    validateUser(userId);
    const raw = await redis.lrange(`history:${userId}`, 0, limit - 1);
    const entries = raw.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
  }
);

// ── Express mounting ──────────────────────────────────────────────────────────

const transports = new Map();

export function mountMcp(app) {
  app.get('/mcp/sse', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    transports.set(transport.sessionId, transport);
    transport.onclose = () => transports.delete(transport.sessionId);
    try {
      await mcp.connect(transport);
    } catch (err) {
      console.error('[mcp] connect error:', err);
      transports.delete(transport.sessionId);
    }
  });

  app.post('/mcp/messages', async (req, res) => {
    const { sessionId } = req.query;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'MCP session not found' });
      return;
    }
    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      console.error('[mcp] handlePostMessage error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  console.log('[mcp] Mounted at /mcp/sse (GET) and /mcp/messages (POST)');
}
