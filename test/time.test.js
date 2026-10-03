import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLocalTime } from '../src/lib/time.js';

const TZ = 'America/Chicago';

test('S0-10: evening request → 08:30 Chicago next day (13:30Z in CDT), not 08:30 UTC', () => {
  const now = new Date('2026-10-03T22:00:00Z'); // 17:00 CDT
  assert.equal(nextLocalTime('08:30', TZ, now).toISOString(), '2026-10-04T13:30:00.000Z');
});

test('S0-10: late-night request before midnight UTC rolls over correctly', () => {
  const now = new Date('2026-10-04T04:30:00Z'); // 23:30 CDT Oct 3
  assert.equal(nextLocalTime('08:30', TZ, now).toISOString(), '2026-10-04T13:30:00.000Z');
});

test('S0-10: early-morning request fires the same local morning', () => {
  const now = new Date('2026-10-03T10:00:00Z'); // 05:00 CDT
  assert.equal(nextLocalTime('08:30', TZ, now).toISOString(), '2026-10-03T13:30:00.000Z');
});

test('S0-10: across the DST change uses the new offset (CST = UTC-6)', () => {
  const now = new Date('2026-11-01T02:00:00Z'); // 21:00 CDT Oct 31; DST ends 02:00 Nov 1
  assert.equal(nextLocalTime('08:30', TZ, now).toISOString(), '2026-11-01T14:30:00.000Z');
});

test('works for UTC and positive-offset zones', () => {
  const now = new Date('2026-10-03T22:00:00Z');
  assert.equal(nextLocalTime('08:30', 'UTC', now).toISOString(), '2026-10-04T08:30:00.000Z');
  assert.equal(nextLocalTime('08:30', 'Asia/Tokyo', now).toISOString(), '2026-10-03T23:30:00.000Z');
});
