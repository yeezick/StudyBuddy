import { redis } from '../redis.js';
import { defaultMastery, updateMastery } from './sm2.js';

const key = (userId, conceptId) => `mastery:${userId}:${conceptId}`;

function parse(raw, conceptId) {
  if (!raw) return defaultMastery(conceptId);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function getMastery(userId, conceptId) {
  const raw = await redis.get(key(userId, conceptId));
  return parse(raw, conceptId);
}

export async function setMastery(userId, mastery) {
  await redis.set(key(userId, mastery.conceptId), JSON.stringify(mastery));
}

export async function getAllMastery(userId, conceptIds) {
  if (conceptIds.length === 0) return [];
  const keys = conceptIds.map((id) => key(userId, id));
  const values = await redis.mget(...keys);
  return conceptIds.map((id, i) => parse(values[i], id));
}

export async function applyQuestionResult(userId, conceptId, qualityScore) {
  const current = await getMastery(userId, conceptId);
  const next = updateMastery(current, qualityScore);
  await setMastery(userId, next);
  return next;
}
