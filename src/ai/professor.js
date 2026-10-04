import { templateFor } from '../lib/templates.js';
import { normalizeSpec } from '../lib/topicSpec.js';
import { DEFAULT_TOPIC_ID } from '../store/topics.js';

// The professor's system prefix for one topic (DEC-049): built only from the topic spec and
// its template, so it is byte-identical for every call on that topic and can be prompt-cached.
// Question writing, the answer key, grading and explain-back all send it first, each followed
// by its own task instructions. Nothing per-request (dates, ids, concepts) goes in here.
export function professorPrefix(spec) {
  const t = templateFor(spec.template);
  const p = spec.professor;
  const sources = spec.sources.length ? spec.sources.map((s) => s.title ?? s.ref).join('; ') : 'none yet';
  const lines = [
    `You are the professor for the study topic "${spec.name}" (template: ${t.label})${p.name && p.name !== 'Professor' ? `; the learner calls you ${p.name}` : ''}.`,
    spec.goal ? `The learner's goal: ${spec.goal}` : null,
    spec.targetDate ? `Target date: ${spec.targetDate}.` : null,
    `Learner level: ${p.level}. Tone: ${p.tone}.`,
    `Sources: ${sources}.`,
    '',
    'Rules for everything you write on this topic:',
    "- Answer from this topic's sources and answer key. In a quiz request, the concepts given (names and summaries) are the answer key.",
    '- Mark any claim the sources and answer key do not support as "unverified".',
    t.answerKeyRequired
      ? '- Every question has an answer key drawn from the sources.'
      : '- Where the sources hold no single right answer, grade against the reference given and say what a calibrated answer looks like.',
    t.hintFirst
      ? '- When tutoring, give a hint before revealing an answer.'
      : '- Exam conditions: no hints before the learner answers.',
    `- When tutoring, ask one unaided recall question every ${t.retrievalCheckEvery} turns.`,
    `- Introduce at most ${t.maxNewConceptsPerSession} new concepts per session.`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

const DEFAULT_SPEC = normalizeSpec({ id: DEFAULT_TOPIC_ID });

// The `system` value for one call: the cached professor prefix, then the task's own
// instructions. Without a spec, the ai-pm default is used.
export function professorSystem(spec, taskSystem) {
  return [
    { type: 'text', text: professorPrefix(spec ?? DEFAULT_SPEC), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskSystem },
  ];
}

// `system` with one more instruction at the end; the cached prefix stays untouched.
export function withSystemNote(system, note) {
  if (typeof system === 'string') return `${system}\n\n${note}`;
  return [...system, { type: 'text', text: note }];
}

export const specOrDefault = (spec) => spec ?? DEFAULT_SPEC;
