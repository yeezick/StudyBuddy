import { store } from '../store/index.js';
import { defaultMastery, updateMastery } from './sm2.js';

export async function getMastery(userId, conceptId) {
  const [card] = await store.getCards(userId, [conceptId]);
  return card ?? defaultMastery(conceptId);
}

export async function setMastery(userId, mastery) {
  await store.saveCard(userId, mastery);
}

export async function getAllMastery(userId, conceptIds) {
  const cards = await store.getCards(userId, conceptIds);
  return conceptIds.map((id, i) => cards[i] ?? defaultMastery(id));
}

export async function applyQuestionResult(userId, conceptId, qualityScore) {
  const current = await getMastery(userId, conceptId);
  const next = updateMastery(current, qualityScore);
  await setMastery(userId, next);
  return next;
}
