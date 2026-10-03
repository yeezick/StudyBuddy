import { z } from 'zod';

// zod strips unknown keys, so every scope field the app reads must be listed here.
export const scopeShape = z.object({
  course: z.string().optional(),
  module: z.string().optional(),
  moduleLabel: z.string().optional(),
  lesson: z.string().optional(),
});

export const conceptShape = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  scope: scopeShape.optional(),
  tags: z.array(z.string()).optional(),
});

export const conceptUpdatesShape = z.object({
  name: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  scope: scopeShape.optional(),
});

// Appends concepts whose id isn't already in the library.
export function mergeNewConcepts(existing, incoming) {
  const existingIds = new Set(existing.map((c) => c.id));
  const added = incoming.filter((c) => !existingIds.has(c.id));
  return { added, merged: [...existing, ...added] };
}

// Patches a concept; scope is merged field by field so a partial scope keeps moduleLabel etc.
export function applyConceptUpdate(concept, updates) {
  const next = { ...concept, ...updates };
  if (updates.scope) next.scope = { ...concept.scope, ...updates.scope };
  return next;
}

// Key-order-independent JSON for comparing concepts.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Plans how to make `existing` match `incoming` exactly. Both are compared as the MCP tools
// store them (conceptShape, unknown keys stripped), so seed-only fields like `mastery` never count.
export function diffConcepts(existing, incoming) {
  const target = incoming.map((c) => conceptShape.parse(c));
  const ids = target.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`Seed has duplicate concept ids: ${[...new Set(dupes)].join(', ')}`);

  const current = new Map(existing.map((c) => [c.id, conceptShape.parse(c)]));
  const add = [];
  const change = [];
  const unchanged = [];
  for (const c of target) {
    const prev = current.get(c.id);
    if (!prev) add.push(c);
    else if (canonical(prev) !== canonical(c)) change.push(c);
    else unchanged.push(c);
  }
  const targetIds = new Set(ids);
  const remove = [...current.values()].filter((c) => !targetIds.has(c.id));
  return { add, change, remove, unchanged };
}
