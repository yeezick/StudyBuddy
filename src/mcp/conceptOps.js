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
