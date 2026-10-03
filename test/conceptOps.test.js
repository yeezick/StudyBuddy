import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptShape, conceptUpdatesShape, mergeNewConcepts, applyConceptUpdate } from '../src/mcp/conceptOps.js';

const concept = {
  id: 'm1-c01',
  name: 'Alpha',
  summary: 'An example.',
  scope: { course: 'Course', module: 'Module 1', moduleLabel: 'Getting Started', lesson: 'L1' },
};

test('S0-11: add_concepts schema keeps scope.moduleLabel', () => {
  assert.equal(conceptShape.parse(concept).scope.moduleLabel, 'Getting Started');
});

test('S0-11: update_concept schema keeps scope.moduleLabel', () => {
  const parsed = conceptUpdatesShape.parse({ scope: { moduleLabel: 'Renamed' } });
  assert.equal(parsed.scope.moduleLabel, 'Renamed');
});

test('S0-11: partial scope update keeps existing moduleLabel and lesson', () => {
  const updated = applyConceptUpdate(concept, conceptUpdatesShape.parse({ scope: { module: 'Module 2' } }));
  assert.deepEqual(updated.scope, { course: 'Course', module: 'Module 2', moduleLabel: 'Getting Started', lesson: 'L1' });
});

test('update without scope leaves scope untouched', () => {
  const updated = applyConceptUpdate(concept, { name: 'Beta' });
  assert.equal(updated.name, 'Beta');
  assert.deepEqual(updated.scope, concept.scope);
});

test('mergeNewConcepts dedupes by id', () => {
  const { added, merged } = mergeNewConcepts([concept], [concept, { ...concept, id: 'm1-c02' }]);
  assert.deepEqual(added.map((c) => c.id), ['m1-c02']);
  assert.equal(merged.length, 2);
});
