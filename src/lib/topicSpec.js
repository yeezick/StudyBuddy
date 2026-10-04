import { DEFAULT_TOPIC_ID } from '../store/topics.js';
import { TEMPLATES, DEFAULT_TEMPLATE_ID } from './templates.js';

// A topic's professor spec (DEC-049): what the user sets on a topic. Stored on the `topics`
// row (see the store's getTopic/saveTopic); professor name, tone, level and template live in
// its `professor` jsonb, session minutes in `schedule_prefs`.
//
//   { id, ownerUserId, name, goal, targetDate, template, professor: { name, tone, level },
//     domain, sources: [{ title, ref }], sessionMinutes, status }
//
// `domain` is the field questions draw their scenarios from ("realistic {domain} context").

export const TOPIC_STATUSES = ['active', 'paused', 'archived'];

// ai-pm as it behaves today (T6-1): Knowledge template, the tone today's prompts already use.
// Used whenever the stored ai-pm row has no professor yet, so production needs no data change.
export const AI_PM_SPEC = Object.freeze({
  id: DEFAULT_TOPIC_ID,
  name: 'AI Product Management',
  goal: 'Retain the Maven AI PM course concepts well enough to use them in product work and interviews.',
  targetDate: null,
  template: 'knowledge',
  professor: Object.freeze({ name: 'Professor', tone: 'strict but fair, generous with partial credit', level: 'working product manager' }),
  domain: 'PM',
  sources: Object.freeze([Object.freeze({ title: 'Maven AI PM course concept library', ref: 'concepts:ai-pm' })]),
  sessionMinutes: 20,
  status: 'active',
});

const GENERIC_PROFESSOR = { name: 'Professor', tone: 'clear and encouraging', level: 'motivated learner' };

// A complete spec from a partial one: unknown template → Knowledge, unknown status → active.
export function normalizeSpec(input = {}) {
  const base = input.id === DEFAULT_TOPIC_ID ? AI_PM_SPEC : null;
  const pick = (k, fallback) => input[k] ?? base?.[k] ?? fallback;
  const template = TEMPLATES[input.template] ? input.template : (base?.template ?? DEFAULT_TEMPLATE_ID);
  const status = TOPIC_STATUSES.includes(input.status) ? input.status : 'active';
  return {
    id: input.id,
    ownerUserId: input.ownerUserId ?? null,
    name: pick('name', input.id),
    goal: pick('goal', null),
    targetDate: pick('targetDate', null),
    template,
    professor: { ...GENERIC_PROFESSOR, ...base?.professor, ...input.professor },
    domain: pick('domain', input.name ?? input.id),
    sources: [...pick('sources', [])],
    sessionMinutes: pick('sessionMinutes', 20),
    status,
  };
}

// The spec a quiz runs with. A stored row without a professor (today's production ai-pm row,
// named "Library") reads as the built-in default for that topic. `store` is passed in so this
// module stays free of import-time side effects (the AI layer imports it).
export async function getTopicSpec(store, topicId = DEFAULT_TOPIC_ID) {
  const stored = await store.getTopic(topicId);
  if (!stored || !stored.professor) return normalizeSpec({ id: topicId, ownerUserId: stored?.ownerUserId, status: stored?.status });
  return normalizeSpec(stored);
}
