import test from 'node:test';
import assert from 'node:assert/strict';
import { dropoffStops, fareForJourney, hasSchedulesOnDate, pickupStops, routesForJourney, schedulesFor } from '../src/data.js';
import { addMinutes, bangkokHour } from '../src/time.js';

async function serverTestApi() {
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  return (await import('../src/server.js')).__test;
}

test('does not treat typed bus times as travel dates', async () => {
  const { parseTypedDate } = await serverTestApi();
  assert.equal(parseTypedDate('ปกติมีรถเย็นมีรอบ18.30'), null);
  assert.equal(parseTypedDate('รอบ 18:30'), null);
  assert.equal(parseTypedDate('มีรอบ 07.30 ไหม'), null);
});

test('still parses explicit travel dates when a time is also present', async () => {
  const { parseTypedDate } = await serverTestApi();
  assert.equal(parseTypedDate('2026-08-14 รอบ 18.30'), '2026-08-14');
  assert.equal(parseTypedDate('14/8/69 เวลา 18:30'), '2026-08-14');
});

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

test('allows short-distance bookings on route at 250 baht', async () => {
  assert.deepEqual((await routesForJourney('bo-win', 'rayong')).map((route) => route.id), ['KOR-RY']);
  assert.equal(await fareForJourney('KOR-RY', 'bo-win', 'rayong'), 250);
  assert.deepEqual((await routesForJourney('map-ta-phut', 'ban-chang')).map((route) => route.id), ['RY-KOR']);
  assert.equal(await fareForJourney('RY-KOR', 'map-ta-phut', 'ban-chang'), 250);
});

test('offers every route stop as a pickup and dropoff in the valid direction', async () => {
  const pickups = (await pickupStops()).map((stop) => stop.id);
  assert.equal(pickups.includes('korat'), true);
  assert.equal(pickups.includes('rayong'), true);
  assert.equal(pickups.includes('chonburi-terminal'), true);

  const kabinDropoffs = (await dropoffStops('kabin')).map((stop) => stop.id);
  assert.equal(kabinDropoffs.includes('korat'), true);
  assert.equal(kabinDropoffs.includes('rayong'), true);
  assert.equal(kabinDropoffs.includes('chonburi-terminal'), true);
});

test('does not expose sample schedules for dates without real data', async () => {
  assert.deepEqual(await schedulesFor('RY-KOR', '2026-07-21'), []);
});

test('has no old example schedule data left', async () => {
  assert.deepEqual(await schedulesFor('RY-KOR', '2026-07-22'), []);
});

test('loads real Korat outbound schedules with bus and driver phones', async () => {
  assert.deepEqual((await schedulesFor('KOR-RY', '2026-08-13')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '09:20 267-7 082-140-4375',
    '10:20 267-15 089-845-7782',
    '12:20 267-10 089-9498867',
    '13:20 267-19 091-342-7497'
  ]);
  assert.deepEqual((await schedulesFor('KOR-CB', '2026-08-13')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '13:00 265-13 06-4775-2023',
    '15:00 265-4 089-844-3052'
  ]);
  assert.deepEqual((await schedulesFor('CB-KOR', '2026-08-13')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '11:00 265-13 06-4775-2023',
    '15:00 265-4 089-844-3052'
  ]);
});

test('loads real Rayong return schedules and keeps unknown driver phones blank', async () => {
  assert.deepEqual((await schedulesFor('RY-KOR', '2026-08-13')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '04:00 267-44 0982713730',
    '06:00 267-19 091-342-7497',
    '09:00 267-29 096-339-0599',
    '11:20 267-23 063-7730807',
    '13:00 267-14 086-2556684',
    '17:00 267-1 081-0734684'
  ]);
});

test('loads real 2026-08-14 partner schedules only', async () => {
  assert.deepEqual((await schedulesFor('KOR-RY', '2026-08-14')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '09:20 267-7 082-140-4375',
    '10:20 267-15 089-845-7782',
    '11:20 267-10 089-9498867',
    '12:20 267-19 091-342-7497'
  ]);
  assert.deepEqual((await schedulesFor('KOR-CB', '2026-08-14')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '11:00 265-6 093-439-1839',
    '13:00 265-12 086-257-9180'
  ]);
  assert.deepEqual((await schedulesFor('CB-KOR', '2026-08-14')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '11:00 265-13 06-4775-2023',
    '15:00 265-4 089-844-3052'
  ]);
  assert.deepEqual((await schedulesFor('RY-KOR', '2026-08-14')).map((item) => `${item.departureTime} ${item.busNumber} ${item.driverPhone}`), [
    '05:00 267-23 063-7730807',
    '06:00 267-7 082-140-4375',
    '07:30 267-15 089-845-7782',
    '12:00 267-10 089-9498867',
    '17:00 267-6 081-0646887'
  ]);
});

test('detects dates with explicit schedules', async () => {
  assert.equal(await hasSchedulesOnDate('2026-08-13'), true);
  assert.equal(await hasSchedulesOnDate('2026-08-14'), true);
  assert.equal(await hasSchedulesOnDate('2026-07-22'), false);
  assert.equal(await hasSchedulesOnDate('2026-08-22'), false);
});

test('adds a stop offset and shows next-day arrival', () => {
  assert.equal(addMinutes('23:40', 40), '00:20 (วันถัดไป)');
});

test('gets Bangkok hour', () => {
  assert.equal(Number.isInteger(bangkokHour()), true);
  assert.equal(bangkokHour() >= 0 && bangkokHour() <= 23, true);
});
