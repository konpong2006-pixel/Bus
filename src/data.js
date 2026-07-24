import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackendSheetValues } from './googleSheets.js';
import { bangkokDate } from './time.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dirname, '..', 'data');
const CACHE_MS = 60_000;

let cache = { expiresAt: 0, value: null };

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

function normalizeActive(value) {
  return String(value ?? 'ใช่').trim() !== 'ไม่';
}

function normalizePlace(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/\./g, '').trim();
}

function parseNumber(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return text.slice(0, 5);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function routeTab(routeId) {
  if (routeId === 'RY-KOR') return 'ราคา ระยอง-โคราช';
  if (routeId === 'KOR-RY') return 'ราคา โคราช-ระยอง';
  if (routeId === 'KOR-CB' || routeId === 'KOR-CBI') return 'ราคา โคราช-ชลบุรี';
  if (routeId === 'CB-KOR' || routeId === 'CBI-KOR') return 'ราคา ชลบุรี-โคราช';
  return null;
}

async function sheetRows(tabName, range) {
  return (await getBackendSheetValues(tabName, range)) ?? null;
}

function fallbackData() {
  const routes = readJson('routes.json').routes;
  const schedules = readJson('schedules.json').schedules;
  const fares = readJson('fares.json').fares.map((fare) => ({
    ...fare,
    active: true,
    pickupName: routes.find((route) => route.id === fare.routeId)?.stops.find((stop) => stop.id === fare.pickupId)?.name,
    dropoffName: routes.find((route) => route.id === fare.routeId)?.stops.find((stop) => stop.id === fare.dropoffId)?.name
  }));
  return { routes, schedules, fares, dayOpen: new Map(), stopTimes: [], source: 'local' };
}

async function loadSheetData() {
  const routeRows = await sheetRows('รายการเส้นทาง', 'A3:D200');
  if (!routeRows) return fallbackData();

  const routeDefs = routeRows
    .filter((row) => row[0] && row[1])
    .map(([sheetName, id, origin, destination]) => ({
      id: String(id).trim(),
      name: String(sheetName).trim(),
      sheetName: String(sheetName).trim(),
      origin: String(origin || '').trim(),
      destination: String(destination || '').trim()
    }));

  const fareGroups = await Promise.all(routeDefs.map(async (route) => {
    const tabName = routeTab(route.id);
    if (!tabName) return [];
    const rows = await sheetRows(tabName, 'A3:E200') ?? [];
    return rows
      .filter((row) => row[0] && row[1] && row[2] !== '' && normalizeActive(row[3]))
      .flatMap(([originPickup, zonePickup, rawPrice]) => {
        const price = parseNumber(rawPrice);
        const destinationName = route.destination;
        const candidates = [
          String(originPickup).trim(),
          String(zonePickup).trim()
        ];
        const seen = new Set();
        return candidates
          .filter((pickupName) => {
            const id = normalizePlace(pickupName);
            if (!id || id === normalizePlace(destinationName) || seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .map((pickupName) => ({
            routeId: route.id,
            pickupId: normalizePlace(pickupName),
            dropoffId: normalizePlace(destinationName),
            pickupName,
            dropoffName: destinationName,
            price,
            active: true
          }));
      })
      .filter((fare) => Number.isFinite(fare.price) && fare.price > 0);
  }));
  const fares = fareGroups.flat();

  const routes = routeDefs.map((route) => {
    const routeFares = fares.filter((fare) => fare.routeId === route.id);
    const stops = [];
    const seen = new Set();
    for (const name of [route.origin, ...routeFares.map((fare) => fare.pickupName), ...routeFares.map((fare) => fare.dropoffName), route.destination]) {
      const id = normalizePlace(name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      stops.push({ id, name, minutesFromOrigin: stops.length });
    }
    return { ...route, stops };
  });

  const scheduleRows = await sheetRows('รอบรถ', 'A3:H500') ?? [];
  const schedules = scheduleRows
    .filter((row) => row[0] && row[1] && row[2] && normalizeActive(row[4]))
    .map(([date, routeName, departureTime, arrivalTime, _active, status, seats, note]) => {
      const route = routeDefs.find((item) => item.sheetName === String(routeName).trim());
      if (!route) return null;
      return {
        id: `${date}-${route.id}-${normalizeTime(departureTime)}`,
        date: String(date).slice(0, 10),
        routeId: route.id,
        departureTime: normalizeTime(departureTime),
        arrivalTime: arrivalTime ? normalizeTime(arrivalTime) : '',
        status: String(status || '').trim(),
        seats: parseNumber(seats) || null,
        note: String(note || '').trim(),
        active: true
      };
    })
    .filter(Boolean);

  const dayRows = await sheetRows('เปิดปิดรายวัน', 'A3:C500') ?? [];
  const dayOpen = new Map(dayRows.filter((row) => row[0]).map((row) => [String(row[0]).slice(0, 10), normalizeActive(row[1])]));

  const stopRows = await sheetRows('เวลาถึงจุดจอด', 'A3:F1000') ?? [];
  const stopTimes = stopRows
    .filter((row) => row[0] && row[1] && row[3] && row[4])
    .map(([routeName, departureTime, _order, stopName, arrivalTime]) => ({
      routeName: String(routeName).trim(),
      departureTime: normalizeTime(departureTime),
      stopName: String(stopName).trim(),
      arrivalTime: normalizeTime(arrivalTime)
    }));

  return { routes, schedules, fares, dayOpen, stopTimes, source: 'sheet' };
}

export async function busData() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  cache = { expiresAt: now + CACHE_MS, value: await loadSheetData() };
  return cache.value;
}

export async function getRoutes() {
  return (await busData()).routes;
}

export async function getRoute(routeId) {
  return (await getRoutes()).find((route) => route.id === routeId);
}

export async function routesForJourney(pickupId, dropoffId) {
  const { routes, fares } = await busData();
  const routeIds = new Set(fares
    .filter((fare) => fare.pickupId === pickupId && fare.dropoffId === dropoffId && fare.active)
    .map((fare) => fare.routeId));
  return routes.filter((route) => routeIds.has(route.id));
}

export async function schedulesFor(routeId, date) {
  const { schedules, dayOpen, source } = await busData();
  if (dayOpen.get(date) === false) return [];
  const dated = schedules
    .filter((item) => item.routeId === routeId && item.date === date && item.active)
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
  if (dated.length || source === 'sheet') return dated;
  return schedules
    .filter((item) => item.routeId === routeId && item.date === null && item.active)
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

export async function hasSchedulesOnDate(date) {
  const { schedules, dayOpen } = await busData();
  if (dayOpen.get(date) === false) return false;
  return schedules.some((item) => item.date === date && item.active);
}

export async function availableScheduleDates(limit = 11) {
  const { schedules, dayOpen } = await busData();
  const today = bangkokDate();
  return [...new Set(schedules
    .filter((item) => item.active && item.date && item.date >= today && dayOpen.get(item.date) !== false)
    .map((item) => item.date))]
    .sort()
    .slice(0, limit);
}

export async function fareForJourney(routeId, pickupId, dropoffId) {
  const { fares } = await busData();
  return fares.find((fare) => fare.routeId === routeId && fare.pickupId === pickupId && fare.dropoffId === dropoffId)?.price ?? null;
}

export async function pickupStops() {
  const { fares } = await busData();
  const seen = new Map();
  for (const fare of fares) seen.set(fare.pickupId, fare.pickupName);
  return [...seen].map(([id, name]) => ({ id, name }));
}

export async function dropoffStops(pickupId) {
  const { fares } = await busData();
  const seen = new Map();
  for (const fare of fares.filter((item) => item.pickupId === pickupId)) seen.set(fare.dropoffId, fare.dropoffName);
  return [...seen].map(([id, name]) => ({ id, name }));
}

export async function stopArrivalTime(routeId, departureTime, stopName) {
  const { routes, stopTimes } = await busData();
  const route = routes.find((item) => item.id === routeId);
  const exact = stopTimes.find((item) =>
    item.routeName === route?.sheetName
    && item.departureTime === departureTime
    && normalizePlace(item.stopName) === normalizePlace(stopName)
  );
  return exact?.arrivalTime ?? null;
}
