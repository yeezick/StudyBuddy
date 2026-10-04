import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { store } from '../store/index.js';
import { QUIZZES_ONLY } from '../lib/retest.js';
import { getConcepts } from '../lib/concepts.js';
import { getAllMastery } from '../lib/mastery.js';
import { isKnownUser } from '../lib/resolveUser.js';
import { conceptShape, conceptUpdatesShape } from './conceptOps.js';

function validateUser(userId) {
  if (!isKnownUser(userId)) {
    throw new Error(`Unauthorized userId: ${userId}.`);
  }
}

// ── MCP server ────────────────────────────────────────────────────────────────

// One McpServer per SSE connection: a server holds a single transport, so sharing one
// made a second client (or a quick reconnect) fail with "Already connected".
export function createMcpServer() {
  const mcp = new McpServer({ name: 'StudyAgent', version: '0.1.0' });

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
      const { added, total } = await store.addConcepts(userId, concepts);
      return {
        content: [{ type: 'text', text: JSON.stringify({ added: added.length, total }) }],
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
    'Patch a single concept (name, summary, tags, or scope). Scope fields are merged, so omitted ones are kept.',
    {
      userId: z.string(),
      conceptId: z.string(),
      updates: conceptUpdatesShape,
    },
    async ({ userId, conceptId, updates }) => {
      validateUser(userId);
      const updated = await store.updateConcept(userId, conceptId, updates);
      if (!updated) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Concept ${conceptId} not found` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] };
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
      const remaining = await store.deleteConcept(userId, conceptId);
      if (remaining === null) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Concept ${conceptId} not found` }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: conceptId, remaining }) }],
      };
    }
  );

  // get_history
  mcp.tool(
    'get_history',
    'Returns last N assessment summaries from the user\'s quiz history. Retests (trigger "retest") are left out unless includeRetests is true.',
    {
      userId: z.string(),
      limit: z.number().int().min(1).max(30).optional(),
      includeRetests: z.boolean().optional(),
    },
    async ({ userId, limit = 10, includeRetests = false }) => {
      validateUser(userId);
      const entries = await store.getHistory(userId, limit, includeRetests ? {} : QUIZZES_ONLY);
      return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
    }
  );

  // get_reviews (read-only)
  mcp.tool(
    'get_reviews',
    'Returns the user\'s review events (one per graded answer), newest first. Optional topicId and since (ISO timestamp, inclusive) filters.',
    {
      userId: z.string(),
      topicId: z.string().optional(),
      since: z.iso.datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ userId, topicId, since, limit = 50 }) => {
      validateUser(userId);
      const events = await store.getReviewEvents(userId, { topicId, since, limit });
      return { content: [{ type: 'text', text: JSON.stringify(events) }] };
    }
  );

  return mcp;
}

// ── Express mounting ──────────────────────────────────────────────────────────

const transports = new Map();

// `auth` guards both routes (requireBearer in production wiring).
export function mountMcp(app, auth) {
  app.get('/mcp/sse', auth, async (req, res) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    transports.set(transport.sessionId, transport);
    transport.onclose = () => transports.delete(transport.sessionId);
    try {
      await createMcpServer().connect(transport);
    } catch (err) {
      console.error('[mcp] connect error:', err);
      transports.delete(transport.sessionId);
    }
  });

  app.post('/mcp/messages', auth, async (req, res) => {
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
