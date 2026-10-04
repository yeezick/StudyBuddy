// Topic templates (DEC-049, design §4). A template sets how a professor teaches; the topic
// spec (lib/topicSpec.js) picks one. Item types are the ones questionGen writes today.
//
//   hintFirst                 give a hint before revealing an answer in conversation
//   retrievalCheckEvery       ask one unaided recall question every N conversation turns
//   maxNewConceptsPerSession  new concepts introduced per session, at most
//   drillTypes                the drills this kind of topic uses (only cards + explain-back run today)
//   itemMix                   question type distribution for quizzes (shares sum to 1)
//   answerKeyRequired         every question must come with an answer key from the sources
//   retentionTarget           FSRS desired retention for the topic's cards
//   queueWeight               weight of the topic's due cards in the daily queue (T6-4)
export const TEMPLATES = Object.freeze({
  knowledge: Object.freeze({
    id: 'knowledge',
    label: 'Knowledge',
    hintFirst: true,
    retrievalCheckEvery: 3,
    maxNewConceptsPerSession: 5,
    drillTypes: ['cards', 'explain_back'],
    itemMix: { mcq: 0.6, short_answer: 0.2, explain: 0.2 },
    answerKeyRequired: true,
    retentionTarget: 0.9,
    queueWeight: 1,
  }),
  hands_on: Object.freeze({
    id: 'hands_on',
    label: 'Hands-on/sensory',
    hintFirst: true,
    retrievalCheckEvery: 2,
    maxNewConceptsPerSession: 3,
    drillTypes: ['structured_log', 'reveal', 'calibration'],
    itemMix: { short_answer: 0.5, scenario: 0.3, explain: 0.2 },
    answerKeyRequired: false,
    retentionTarget: 0.85,
    queueWeight: 0.8,
  }),
  cert_exam: Object.freeze({
    id: 'cert_exam',
    label: 'Certification exam',
    hintFirst: false,
    retrievalCheckEvery: 2,
    maxNewConceptsPerSession: 8,
    drillTypes: ['cards', 'timed_practice'],
    itemMix: { mcq: 0.7, scenario: 0.2, short_answer: 0.1 },
    answerKeyRequired: true,
    retentionTarget: 0.92,
    queueWeight: 1.5,
  }),
  knowledge_project: Object.freeze({
    id: 'knowledge_project',
    label: 'Knowledge + project',
    hintFirst: true,
    retrievalCheckEvery: 3,
    maxNewConceptsPerSession: 4,
    drillTypes: ['cards', 'explain_back', 'critique', 'design'],
    itemMix: { mcq: 0.4, short_answer: 0.2, explain: 0.2, scenario: 0.2 },
    answerKeyRequired: true,
    retentionTarget: 0.9,
    queueWeight: 1,
  }),
});

export const DEFAULT_TEMPLATE_ID = 'knowledge';

export const templateFor = (id) => TEMPLATES[id] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
