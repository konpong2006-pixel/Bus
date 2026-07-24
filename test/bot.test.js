import test from 'node:test';
import assert from 'node:assert/strict';
import { fareForJourney, hasSchedulesOnDate, routesForJourney, schedulesFor } from '../src/data.js';
import { addMinutes, bangkokHour } from '../src/time.js';

test('finds the forward route when pickup precedes dropoff', async () => {
  assert.deepEqual((await routesForJourney('rayong', 'korat')).map((route) => route.id), ['RY-KOR']);
});

test('does not allow travel against a route direction', async () => {
  assert.equal((await routesForJourney('nava-nakhon', 'rayong')).length, 0);
});

test('locks Korat outbound fares by destination zone', async () => {
  assert.equal(await fareForJourney('KOR-RY', 'korat', 'rayong'), 350);
  assert.equal(await fareForJourney('KOR-RY', 'korat', 'bo-win'), 300);
  assert.equal(await fareForJourney('KOR-RY', 'korat', 'kabin'), 250);
});

test('locks Rayong outbound fares by destination zone', async () => {
  assert.equal(await fareForJourney('RY-KOR', 'rayong', 'korat'), 350);
  assert.equal(await fareForJourney('RY-KOR', 'rayong', 'wang-nam-khiao'), 350);
  assert.equal(await fareForJourney('RY-KOR', 'rayong', 'kabin'), 250);
});

test('uses daily default schedules when no date-specific schedule exists', async () => {
  assert.deepEqual((await schedulesFor('RY-KOR', '2026-07-21')).map((item) => item.departureTime), ['04:00', '06:00', '10:00']);
});

test('uses date-specific schedules in preference to defaults', async () => {
  assert.deepEqual((await schedulesFor('RY-KOR', '2026-07-22')).map((item) => item.departureTime), ['07:00']);
});

test('detects dates with explicit schedules', async () => {
  assert.equal(await hasSchedulesOnDate('2026-07-22'), true);
  assert.equal(await hasSchedulesOnDate('2026-08-22'), false);
});

test('adds a stop offset and shows next-day arrival', () => {
  assert.equal(addMinutes('23:40', 40), '00:20 (วันถัดไป)');
});

test('gets Bangkok hour', () => {
  assert.equal(Number.isInteger(bangkokHour()), true);
  assert.equal(bangkokHour() >= 0 && bangkokHour() <= 23, true);
});
