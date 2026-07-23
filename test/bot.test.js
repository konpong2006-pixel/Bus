import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSchedulesOnDate, routesForJourney, schedulesFor } from '../src/data.js';
import { addMinutes, bangkokHour } from '../src/time.js';

test('finds the forward route when pickup precedes dropoff', () => {
  assert.deepEqual(routesForJourney('km10', 'korat').map((route) => route.id), ['RY-KOR']);
});

test('does not allow travel against a route direction', () => {
  assert.equal(routesForJourney('korat', 'km10').length, 0);
});

test('uses daily default schedules when no date-specific schedule exists', () => {
  assert.deepEqual(schedulesFor('RY-KOR', '2026-07-21').map((item) => item.departureTime), ['04:00', '06:00', '10:00']);
});

test('uses date-specific schedules in preference to defaults', () => {
  assert.deepEqual(schedulesFor('RY-KOR', '2026-07-22').map((item) => item.departureTime), ['07:00']);
});

test('detects dates with explicit schedules', () => {
  assert.equal(hasSchedulesOnDate('2026-07-22'), true);
  assert.equal(hasSchedulesOnDate('2026-08-22'), false);
});

test('adds a stop offset and shows next-day arrival', () => {
  assert.equal(addMinutes('23:40', 40), '00:20 (วันถัดไป)');
});

test('gets Bangkok hour', () => {
  assert.equal(Number.isInteger(bangkokHour()), true);
  assert.equal(bangkokHour() >= 0 && bangkokHour() <= 23, true);
});
