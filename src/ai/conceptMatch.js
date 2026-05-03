import { callJSON } from './anthropic.js';

const SYSTEM = `Given a learning objective and concept list, return the IDs of the most relevant concepts. Return ONLY a JSON array of ID strings. No preamble.`;

export async function matchConceptsToPrompt(prompt, concepts) {
  const user = `Objective: "${prompt}"

Concepts (id | name | summary):
${concepts.map((c) => `${c.id} | ${c.name} | ${c.summary}`).join('\n')}

Return 5–10 concept IDs: ["id1", "id2", ...]`;

  const ids = await callJSON({ system: SYSTEM, user, max_tokens: 1024 });

  if (!Array.isArray(ids)) {
    throw new Error('conceptMatch: expected JSON array, got ' + typeof ids);
  }

  const validIds = new Set(concepts.map((c) => c.id));
  return ids.filter((id) => typeof id === 'string' && validIds.has(id));
}
